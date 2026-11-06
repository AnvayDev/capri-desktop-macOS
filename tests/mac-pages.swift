// Compiled with the actual helper and CAPRI_TESTS, so no desktop watch or key presses run.
var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
  checks += 1
}

for (key, hosts) in AI_HOSTS {
  for host in hosts {
    check(siteOf("https://\(host)/conversation/123") == key, "conversation on \(host)")
    check(siteOf("https://\(host).example.org/") == nil, "lookalike suffix")
  }
}
check(siteOf("https://CHATGPT.COM/c/123") == "chatgpt", "case insensitive host")
check(siteOf("https://www.perplexity.ai/") == "perplexity", "subdomain")
check(siteOf("https://chatgpt.com@example.org/") == nil, "user info is not a host")
check(siteOf("file://chatgpt.com/local") == nil, "only web addresses")
check(addressOf(URL(string: "https://chatgpt.com/c/123")!) != nil, "CFURL/string bridging")
check(addressOf("not a URL") == nil, "invalid address")

let conversation = detectsAI("A title with no brand", name: "safari", browser: true, address: "https://chatgpt.com/c/123")
check(conversation.keys == ["chatgpt"] && conversation.pages == ["chatgpt"], "URL identifies custom conversation titles")
let article = detectsAI("ChatGPT", name: "safari", browser: true, address: "https://example.org/article")
check(article.pages.isEmpty && !article.download, "known non-AI site overrides title")
check(!canClosePage("chatgpt", title: "ChatGPT", address: "https://example.org/article"), "do not close that article")
check(canClosePage("chatgpt", title: "A custom title", address: "https://chatgpt.com/c/123"), "close a conversation by URL")
check(!canClosePage("chatgpt", title: "ChatGPT", address: "https://claude.ai/chat/123"), "do not close a different AI from an old request")
check(canClosePage("chatgpt", title: "Download ChatGPT", address: "https://openai.com/chatgpt/download/"), "download behavior retained")
check(canClosePage("chatgpt", title: "ChatGPT — Firefox", address: nil), "title fallback for browsers without URLs")
check(!canClosePage("unknown", title: "ChatGPT", address: "https://chatgpt.com"), "unknown key")
let another = detectsAI("ChatGPT - Download", name: "safari", browser: true, address: "https://claude.ai/chat/123")
check(another.keys == ["claude"] && another.pages == ["claude"] && !another.download, "URL wins over other brands and download words in titles")

final class PageNode {
  var attrs: [String: Any]
  var children: [PageNode]
  init(_ role: String = "AXGroup", url: String? = nil, children: [PageNode] = []) {
    self.attrs = [kAXRoleAttribute: role]
    if let url = url { self.attrs[kAXURLAttribute] = url }
    self.children = children
  }
}
func readPage(_ node: PageNode, expired: () -> Bool = { false }) -> (url: String?, complete: Bool) {
  return pageAddress(node, read: { $0.attrs[$1] }, children: { $0.children }, expired: expired)
}
let oldTab = PageNode("AXWebArea", url: "https://chatgpt.com/c/old")
let ordinaryTab = PageNode("AXWebArea", url: "https://example.org/")
let window = PageNode("AXWindow", children: [oldTab])
check(readPage(window).url == "https://chatgpt.com/c/old", "first active tab")
window.children = [ordinaryTab]
check(readPage(window).url == "https://example.org/", "tab switch in the same window discards the old area")
window.children = [oldTab, ordinaryTab]
oldTab.attrs["AXHidden"] = true
check(readPage(window).url == "https://example.org/", "hidden background tab is ignored")
oldTab.attrs["AXHidden"] = false
check(!readPage(window).complete, "ambiguous visible pages cannot authorize a close")
ordinaryTab.children = [oldTab]
window.children = [ordinaryTab]
check(readPage(window).url == "https://example.org/", "nested AI iframe is not the current page")
window.attrs[kAXDocumentAttribute] = "https://claude.ai/chat/123"
check(readPage(window).url == "https://claude.ai/chat/123", "window document takes precedence")
check(!readPage(window, expired: { true }).complete, "deadline applies to document reads too")
window.attrs.removeValue(forKey: kAXDocumentAttribute)
window.children = [PageNode("AXWebArea")]
check(!readPage(window).complete, "loading or invalid web area cannot authorize a close")
window.children = (0..<501).map { _ in PageNode() }
check(!readPage(window).complete, "bounded tree traversal")
window.children = []
check(readPage(window).complete && readPage(window).url == nil, "unsupported URL exposes title fallback")
print("macOS page tests: \(checks) checks passed")
