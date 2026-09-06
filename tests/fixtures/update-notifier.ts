/** Manual browser smoke fixture; all update responses are synthetic. */
import { PanelController } from '../../src/client/controller.ts'
import { mountSidebarEntry } from '../../src/client/sidebar-entry.ts'
import { mountUpdateDialog } from '../../src/client/UpdateDialog.tsx'
import { UpdatesStore } from '../../src/client/updates.ts'
import { setTranslator } from '../../src/client/translate.ts'
import { zh, en, type BrowserKey } from '../../src/client/locales.ts'
import { updateSnapshot } from './updates.ts'

const scenario = document.querySelector<HTMLSelectElement>('#scenario')!
const language = document.querySelector<HTMLSelectElement>('#language')!
const controller = new PanelController()
const store = new UpdatesStore(async () => {
  const value = updateSnapshot()
  value.checkedAt = Date.now()
  value.github.release!.notes = '优化实时页面批注体验\n修复轻量编辑器的文件预览\n本页面为本地模拟数据'
  if (scenario.value === 'latest') value.currentVersion = '0.3.0'
  if (scenario.value === 'failed') value.npm = { state: 'error' }
  if (scenario.value === 'lag') value.npm.release!.version = '0.2.0'
  if (scenario.value === 'repository') {
    value.installation = 'source'
    value.followRepository = true
    value.currentRevision = 'a'.repeat(40)
    value.repository = {
      state: 'ok', comparison: 'ahead', branch: 'master', aheadBy: 2, revision: 'b'.repeat(40),
      url: 'https://github.com/Nono-neko/dsh-browser/compare/' + 'a'.repeat(40) + '...' + 'b'.repeat(40),
    }
  }
  return new Response(JSON.stringify({ ok: true, value }))
})
setTranslator(key => (language.value === 'en' ? en : zh)[key as BrowserKey] ?? key)
const stop = store.start()
const dialog = mountUpdateDialog(store)
const unmountSidebar = mountSidebarEntry(controller, { store, open: dialog.open })
scenario.addEventListener('change', () => { void store.read() })
language.addEventListener('change', () => { void store.read() })
document.querySelector<HTMLSelectElement>('#theme')!.addEventListener('change', event => {
  document.documentElement.dataset.theme = (event.target as HTMLSelectElement).value
})
const iframe = document.querySelector<HTMLIFrameElement>('iframe')!
iframe.srcdoc = '<!doctype html><style>body{height:1600px;background:#101727;color:#ced9ee;font:18px system-ui;padding:60px} .orb{width:100px;height:100px;border-radius:50%;background:#8897df;animation:drift 2s ease-in-out infinite alternate}@keyframes drift{to{transform:translateX(240px);background:#74c7b2}} h2{margin-top:240px}</style><div class="orb"></div><h1>动画保持运行</h1><p>计数：<span id="counter">0</span></p><h2>滚动至此再打开更新详情</h2><script>window.ticks=0;setInterval(()=>{document.querySelector("#counter").textContent=++window.ticks},200)</script>'
window.addEventListener('pagehide', () => { unmountSidebar(); dialog.dispose(); stop() }, { once: true })
