const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
if (fs.existsSync('data/app.db')) {
  const db = new DatabaseSync('data/app.db');
  try {
    const rows = db.prepare('SELECT key, substr(value,1,200) AS v FROM app_settings').all();
    console.log(JSON.stringify(rows, null, 1));
  } catch (e) {
    console.log('app_settings 读取失败: ' + e.message);
  }
} else {
  console.log('data/app.db 不存在');
}
console.log('.env exists:', fs.existsSync('.env'));
