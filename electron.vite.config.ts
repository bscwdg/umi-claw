import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
 main: {
  build: {
    outDir: 'dist-electron/main',  // 👈 改这里
    lib: {
      entry: resolve(__dirname, 'electron/main/index.ts'),
      formats: ['cjs']
    }
  }
},

  preload: {
  build: {
    outDir: 'dist-electron/preload', // 👈 改这里
    lib: {
      entry: resolve(__dirname, 'electron/preload/index.ts'),
      formats: ['cjs']
    }
  }
},

 renderer: {
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  plugins: [vue()]   
}
})