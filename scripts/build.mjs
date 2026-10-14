import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const name of ['index.html', 'app.js', 'style.css', 'peerjs-1.5.5.min.js', 'PeerJS-LICENSE.txt']) {
  await copyFile(name, `dist/${name}`);
}
