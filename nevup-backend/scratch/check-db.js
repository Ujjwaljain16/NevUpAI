const { Pool } = require('pg');
const pool = new Pool({
  connectionString: "postgres://postgres:postgres@localhost:5432/nevup",
  connectionTimeoutMillis: 2000,
});

async function check() {
  try {
    const res = await pool.query("SELECT 1");
    console.log("DB Connection Success:", res.rows);
  } catch (err) {
    console.error("DB Connection Failed:", err.message);
  } finally {
    await pool.end();
  }
}

check();
