import { fileURLToPath, URL } from "node:url";

import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import { createSvgIconsPlugin } from "vite-plugin-svg-icons";
const wasmAsUrl = (): Plugin => ({
  name: "wasm-as-url",
  enforce: "pre",
  async resolveId(source, importer, options) {
    if (!source.endsWith(".wasm")) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved || resolved.id.includes("?")) return resolved;
    return `${resolved.id}?url`;
  }
});

const OCCT_NODE_BUILTINS = new Set(["path", "fs", "crypto", "node:path", "node:fs", "node:crypto"]);
const OCCT_EMPTY_ID = "\0occt-node-builtin-stub";

const stubOcctNodeBuiltins = (): Plugin => ({
  name: "stub-occt-node-builtins",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === OCCT_EMPTY_ID) return OCCT_EMPTY_ID;
    if (!importer || !OCCT_NODE_BUILTINS.has(source)) return null;
    if (!importer.includes("opencascade.js")) return null;
    return OCCT_EMPTY_ID;
  },
  load(id) {
    if (id !== OCCT_EMPTY_ID) return null;
    return "export default {};";
  }
});

export default defineConfig({
  plugins: [wasmAsUrl(), stubOcctNodeBuiltins(), vue(), createSvgIconsPlugin({
    iconDirs: [resolve(process.cwd(), "src/assets/svgs")],
    symbolId: "icon-[dir]-[name]"
  })],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['opencascade.js'],
    include: ['gl-matrix', 'jszip', 'comlink']
  },
  worker: {
    format: 'es',
    plugins: () => [wasmAsUrl(), stubOcctNodeBuiltins()],
    rollupOptions: {
      output: {
        format: 'es'
      }
    }
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5678,
    open: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000/",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, "")
      }
    }
  },
  css: {
    preprocessorOptions: {
      scss: {}
    }
  },
  build: {
    outDir: "dist",
    minify: true,
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        chunkFileNames: "assets/js/[name]-[hash].js",
        entryFileNames: "assets/js/[name]-[hash].js",
        assetFileNames: "assets/[ext]/[name]-[hash].[ext]"
      }
    }
  }
});
