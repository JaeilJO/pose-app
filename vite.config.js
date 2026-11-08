import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained index.html: easy to host anywhere (or as a claude.ai artifact).
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: 'es2020' },
});
