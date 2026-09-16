// The generated module exists during gateway builds. This declaration keeps
// regular typecheck and test compilation independent from build artifacts.
declare module "*.generated.js" {
  export const WEB_UI_HTML: string;
}
