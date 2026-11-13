import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist-electron/main',
      lib: {
        entry: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          // B1：第三方插件子进程入口单独产出一个 CJS 文件（utilityProcess.fork 用）
          pluginProcessChild: resolve(__dirname, 'electron/main/kernel/pluginProcessChild.ts')
        },
        formats: ['cjs'],
        fileName: (_format, entryName) => `${entryName}.js`
      }
    }
  },

  preload: {
    build: {
      outDir: 'dist-electron/preload',
      // 双入口：主窗全量 preload + 桌宠窗口最小 preload（§13.1-2）
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          pet: resolve(__dirname, 'electron/preload/pet.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },

  renderer: {
    base: './',

    // 🟢 核心修复：把渲染进程的前端产物也强行统一到 dist-electron 目录下
    build: {
      outDir: 'dist-electron/renderer'
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    plugins: [vue()]
  }
})
