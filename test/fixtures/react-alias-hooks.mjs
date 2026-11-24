// node の module の解き方の hook: 'react' を試験用の小さな React（mini-react.mjs）に向ける。office の欄を node で描く試験だけが register する
const MINI = new URL('./mini-react.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'react') return { url: MINI, shortCircuit: true };
  return next(specifier, context);
}
