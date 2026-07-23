// Stand-in for the `vscode` module so a webview panel's `renderHtml` can be
// esbuild-bundled and imported outside the extension host, purely to
// produce its HTML string for the visual/screenshot harness
// (scripts/render-webviews.mjs). Every panel imports vscode only as
// `import * as vscode from 'vscode'` (verified across all of src/), never
// a named import, so this needs no real exports -- accessing any
// `vscode.*` property on an empty namespace object just yields `undefined`
// at runtime, which is harmless because renderHtml never reads anything
// off the vscode import itself (only off the fake `webview` object the
// harness constructs directly -- see render-webviews.mjs). Every other
// `vscode.*` use in these files lives inside class methods/constructors
// that the harness never calls (it only calls the plain exported
// `renderHtml` functions), so nothing here needs to behave like real
// VS Code.
export default {};
