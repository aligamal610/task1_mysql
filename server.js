"use strict";

const express = require("express");
const session = require("express-session");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();

const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");

app.set("views", path.join(__dirname, "public"));


app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-me",
    resave: false,
    saveUninitialized: false,
  })
);


app.use((req, res, next) => {
  if (req.path.endsWith(".ejs")) return res.status(404).send("Not found");
  next();
});


app.use(express.static(path.join(__dirname, "public")));

/* ---------- helpers ---------- */

function isLoggedIn(req) {
  return !!req.session?.rootPass;
}

async function testRootConn(pass) {
  try {
    const conn = await mysql.createConnection({
      host: MYSQL_HOST,
      user: "root",
      password: pass,
    });
    await conn.ping();
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

async function getConn(req) {
  if (!req.session?.rootPass) {
    throw new Error("not logged in");
  }
  const conn = await mysql.createConnection({
    host: MYSQL_HOST,
    user: "root",
    password: req.session.rootPass,
    multipleStatements: false,
    charset: "utf8mb4",
  });
  return conn;
}

// letters/numbers/_; must start with letter/_
function sanitizeIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    const err = new Error(`Invalid identifier: ${name}`);
    err.status = 400;
    throw err;
  }
  return name;
}

function ensureLoggedIn(req, res, next) {
  if (!isLoggedIn(req)) return res.redirect("/?err=auth");

  testRootConn(req.session.rootPass).then((ok) => {
    if (!ok) {
      req.session.rootPass = undefined;
      return res.redirect("/?err=auth");
    }
    next();
  });
}

/* ---------- routes ---------- */

// page 1: login
app.get("/", (req, res) => {
  res.render("login", {
    error: req.query.error || "",
    err: req.query.err === "auth" ? "Session expired. Please log in again." : "",
  });
});

app.post("/login", async (req, res) => {
  const pass = String(req.body.password || "");
  if (!pass) return res.redirect("/?error=Root%20password%20required");
  const ok = await testRootConn(pass);
  if (!ok) return res.redirect("/?error=Login%20failed.%20Check%20root%20password.");
  req.session.rootPass = pass;
  res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

// page 2: dashboard
app.get("/dashboard", ensureLoggedIn, async (req, res) => {
  const systemSchemas = ["information_schema", "mysql", "performance_schema", "sys"];
  let okMsg = req.query.ok || "";
  let errMsg = req.query.err || "";

  const conn = await getConn(req);
  try {
    const [dbRows] = await conn.query("SHOW DATABASES");
    const dbs = dbRows
      .map((r) => r.Database)
      .filter((d) => !systemSchemas.includes(d))
      .sort();

    const [userRows] = await conn.query("SELECT User, Host FROM mysql.user ORDER BY User, Host");

    res.render("dashboard", { dbs, users: userRows, okMsg, errMsg });
  } catch (e) {
    res.render("dashboard", { dbs: [], users: [], okMsg, errMsg: e.message });
  } finally {
    await conn.end();
  }
});

// page 3: add database
app.get("/add-db", ensureLoggedIn, (req, res) => {
  res.render("add_db", { err: "" });
});

app.post("/add-db", ensureLoggedIn, async (req, res) => {
  try {
    const name = sanitizeIdentifier(String(req.body.db_name || "").trim());
    const conn = await getConn(req);
    try {
      await conn.query("CREATE DATABASE `" + name + "`");
      res.redirect("/dashboard?ok=" + encodeURIComponent(`Database '${name}' created`));
    } finally {
      await conn.end();
    }
  } catch (e) {
    res.render("add_db", { err: e.message });
  }
});

// page 4: add user (grant to one DB)
app.get("/add-user", ensureLoggedIn, async (req, res) => {
  const systemSchemas = ["information_schema", "mysql", "performance_schema", "sys"];
  const conn = await getConn(req);
  try {
    const [dbRows] = await conn.query("SHOW DATABASES");
    const dbs = dbRows
      .map((r) => r.Database)
      .filter((d) => !systemSchemas.includes(d))
      .sort();
    res.render("add_user", { dbs, err: "" });
  } catch (e) {
    res.render("add_user", { dbs: [], err: e.message });
  } finally {
    await conn.end();
  }
});

app.post("/add-user", ensureLoggedIn, async (req, res) => {
  const conn = await getConn(req);
  try {
    const user = sanitizeIdentifier(String(req.body.username || "").trim());
    const host = String(req.body.host || "localhost").trim() || "localhost";
    const dbName = sanitizeIdentifier(String(req.body.db_name || "").trim());
    const pass = String(req.body.password || "");

    const u = conn.escape(user);
    const h = conn.escape(host);
    const p = conn.escape(pass);

    await conn.beginTransaction();
    await conn.query(`CREATE USER IF NOT EXISTS ${u}@${h} IDENTIFIED BY ${p}`);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ${u}@${h}`);
    await conn.commit();

    res.redirect(
      "/dashboard?ok=" +
        encodeURIComponent(`User '${user}'@'${host}' created and granted on ${dbName}`)
    );
  } catch (e) {
    try { await conn.rollback(); } catch {}
    const systemSchemas = ["information_schema", "mysql", "performance_schema", "sys"];
    const [dbRows] = await conn.query("SHOW DATABASES");
    const dbs = dbRows
      .map((r) => r.Database)
      .filter((d) => !systemSchemas.includes(d))
      .sort();
    res.render("add_user", { dbs, err: e.message });
  } finally {
    await conn.end();
  }
});

// page 5: add table (for selected DB)
app.get("/add-table", ensureLoggedIn, async (req, res) => {
  const db = String(req.query.db || "");
  let dbName = "";
  try {
    dbName = db ? sanitizeIdentifier(db) : "";
  } catch (e) {
    return res.render("add_table", { dbName: "", err: "Invalid DB name" });
  }
  res.render("add_table", { dbName, err: "" });
});

app.post("/add-table", ensureLoggedIn, async (req, res) => {
  try {
    const dbName = sanitizeIdentifier(String(req.body.db || ""));
    const tableName = sanitizeIdentifier(String(req.body.table_name || ""));
    const rowsStr = String(req.body.rows || "").trim(); // e.g. "0,1,3"
    const idxs = rowsStr ? rowsStr.split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n)) : [];

    if (!idxs.length) throw new Error("Add at least one column.");

    const allowed = new Set(["INT", "VARCHAR", "TEXT", "DATE", "DATETIME", "FLOAT", "BOOLEAN"]);
    const parts = [];

    for (const i of idxs) {
      const cname = sanitizeIdentifier(String(req.body[`col_${i}`] || "").trim());
      let ctype = String(req.body[`type_${i}`] || "").trim().toUpperCase();
      if (!allowed.has(ctype)) throw new Error(`Bad type: ${ctype}`);
      const len = String(req.body[`len_${i}`] || "").trim();
      const nullable = req.body[`nullable_${i}`] ? "NULL" : "NOT NULL";

      const lenSql = ctype === "VARCHAR" && len ? `(${parseInt(len, 10) || 255})` : "";
      const typeSql = ctype === "BOOLEAN" ? "TINYINT(1)" : `${ctype}${lenSql}`;
      parts.push("`" + cname + "` " + typeSql + " " + nullable);
    }

    const conn = await getConn(req);
    try {
      const sql =
        "CREATE TABLE `"+dbName+"`.`"+tableName+"` (\n  " +
        parts.join(",\n  ") +
        "\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
      await conn.query(sql);
      res.redirect("/dashboard?ok=" + encodeURIComponent(`Table '${tableName}' created in ${dbName}`));
    } finally {
      await conn.end();
    }
  } catch (e) {
    res.render("add_table", {
      dbName: String(req.body.db || ""),
      err: e.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Mini Admin listening on http://127.0.0.1:${PORT}`);
});
