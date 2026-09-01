#!/usr/bin/env node
/**
 * 构建 dsh-redact 客户端插件（设置页「数据脱敏」Tab）。
 * 产物为 window.__ModuleLoader__.load 自注册 bundle（lib/client.js）。
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgName = '@dsh-extra/dsh-redact'

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-api-remotes/client',
]

const banner = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkgName)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;`

const footer = `		return module.exports;
	}
});`

await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: resolve(root, 'lib/client.js'),
  external: EXTERNALS,
  banner: { js: banner },
  footer: { js: footer },
  minify: true,
  logLevel: 'info',
})
