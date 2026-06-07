const fs = require('fs');
const readline = require('readline');

const logPath = 'C:\\Users\\red\\.gemini\\antigravity\\brain\\e58878b7-2a30-4221-9f77-0d4213855460\\.system_generated\\logs\\transcript.jsonl';

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  const lowercase = line.toLowerCase();
  if (lowercase.includes('login') || lowercase.includes('password') || lowercase.includes('network') || lowercase.includes('offline') || lowercase.includes('uri')) {
    try {
      const obj = JSON.parse(line);
      if (obj.source === 'USER_EXPLICIT' || obj.source === 'USER') {
        console.log(`Step ${obj.step_index} (${obj.source} - ${obj.type}):`);
        console.log(`Content: ${obj.content}\n`);
      }
    } catch (e) {
      // ignore
    }
  }
});
