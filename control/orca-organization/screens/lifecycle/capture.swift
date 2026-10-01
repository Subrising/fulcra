import Cocoa
import WebKit
let args = CommandLine.arguments
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let width = Double(args[3])!, height = Double(args[4])!
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.borderless], backing: .buffered, defer: false)
let web = WKWebView(frame: window.contentView!.bounds)
window.contentView!.addSubview(web)
window.orderBack(nil)
final class Delegate: NSObject, WKNavigationDelegate {
 func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
  DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
   web.evaluateJavaScript("document.querySelector('[aria-label=\"Preview clean-up\"]').click()") { _, error in
    if error != nil { print("Preview failed"); exit(1) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
     web.evaluateJavaScript("JSON.stringify({text:document.body.innerText,confirm:!!document.querySelector('[aria-label=\"Confirm clean-up\"]'),overflow:document.body.scrollWidth>innerWidth,calls:window.__calls})") { value, error in
      guard error == nil, let value = value as? String else { exit(2) }
      try! value.write(toFile: args[2] + ".json", atomically: true, encoding: .utf8)
      web.takeSnapshot(with: nil) { image, error in
       guard let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(3) }
       try! png.write(to: URL(fileURLWithPath: args[2]))
       web.evaluateJavaScript("document.querySelector('[aria-label=\"Confirm clean-up\"]').click()") { _, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
         web.evaluateJavaScript("document.body.innerText.includes('1 jobs cleaned')") { result, _ in exit((result as? Bool) == true ? 0 : 4) }
        }
       }
      }
     }
    }
   }
  }
 }
}
let delegate = Delegate(); web.navigationDelegate = delegate
web.load(URLRequest(url: URL(string: args[1])!))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(5) }
app.run()
