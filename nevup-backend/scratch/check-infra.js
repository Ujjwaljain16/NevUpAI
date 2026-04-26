const { Pool } = require('pg');
const Redis = require('ioredis');

async function check() {
  const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/nevup' });
  const redis = new Redis('redis://localhost:6379');

  try {
    await pool.query('SELECT 1');
    console.log('DB OK');
  } catch (e) {
    console.log('DB FAIL:', e.message);
  }

  try {
    const pong = await redis.ping();
    console.log('REDIS OK:', pong);
  } catch (e) {
    console.log('REDIS FAIL:', e.message);
  }

  await pool.end();
  await redis.quit();
}

check();
