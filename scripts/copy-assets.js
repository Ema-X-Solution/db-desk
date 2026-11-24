const fs = require('fs');
fs.mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'styles.css']) fs.copyFileSync('src/renderer/' + f, 'dist/renderer/' + f);
