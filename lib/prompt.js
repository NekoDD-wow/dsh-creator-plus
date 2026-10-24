// 给创造模式的简短提醒与工具描述。保持短：段落每轮都进系统提示词。

export const REMINDER = `## Clone check before touching the live client (Creator Mode Plus)
Installing or changing a plugin in this profile can crash the user's own client. Before \`plugin_manager install_bundle\`, enabling a plugin, or editing a patch that changes the Web UI, run \`clone_check\` with the bundle's absolute directory. It boots a disposable copy of DSH in a temporary DSH_HOME, installs the bundle there, and opens the Web UI in a headless browser.
- Install into the live profile only after clone_check reports ok. If it fails, fix the bundle and run it again; report the errors instead of installing.
- clone_check is the sanctioned exception to the cordis-plugin-development verification rule against launching a separate browser or changing HOME: use the tool, never hand-built shell commands for this.
- Use mode "copy" only to reproduce a conflict with plugins already installed; "clean" (default) isolates the bundle under test.
- To let the user look at the clone, pass keepAlive: true, give them the returned viewUrl as a link (it opens in the sidebar browser when their link preference is in-app), and call clone_close when they are done.`

export const CHECK_DESCRIPTION = 'Boot a disposable DSH clone (temporary DSH_HOME, fresh "web" profile or a copy of the current one), install the bundle under test into it, start its Web UI on a free port, and open it in a headless Edge/Chrome/Chromium to confirm the front end still starts: no page errors, no console errors, non-blank root, optional expected text or selector. Returns a verdict, the errors, a screenshot path for read_image, and per-step timings. The live profile is never touched. Takes about 30 s to a few minutes.'

export const CLOSE_DESCRIPTION = 'Stop a clone kept alive by clone_check (keepAlive: true) and delete its temporary directory. Pass the clone id, or "all".'
