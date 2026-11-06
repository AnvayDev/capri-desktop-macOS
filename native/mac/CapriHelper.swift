// Capri's helper on macOS: what windows.ps1 and the PowerShell one-liners do on Windows.
//
//   capri-helper watch <capri pid> <overlay window id>
//       One JSON line whenever something changes: the window in front and the visible windows in
//       z-order (front first), as frame bounds in screen points. No contents, and no titles: the
//       title of the window in front is only checked against a short list of AI names for her
//       jealousy, and all that goes out is which of them matched ("ai"), whether it's their own page
//       in a browser ("pages") and whether it's a page to download one ("dl"). Also the game in front
//       ("game"), the USB sticks plugged in ("usb", by volume name) and the last USB device plugged in
//       or out ("plug"). Reads "close <id> <key> <n>" lines on its input: she closes that page.
//   capri-helper apps <capri pid>            the apps open, as JSON
//   capri-helper quit|kill <pid>...          closes them (like ⌘Q), or forces them; prints how many are left
//   capri-helper hide <capri pid> | unhide   every app out of the way, or back
//   capri-helper place <pid> <x> <y> <w> <h> that app's window there (Accessibility)
//   capri-helper activate <pid>              that app in front
//   capri-helper media play|next|previous    the media keys
//   capri-helper lock                        locks the screen
//   capri-helper trusted [prompt]            whether Capri may use Accessibility (and asks if `prompt`)
//
// Built by scripts/build-mac.sh (universal: Apple silicon and Intel).

import Cocoa
import ApplicationServices
import Carbon
import DiskArbitration
import IOKit

setvbuf(stdout, nil, _IOLBF, 0)

// MARK: - output

func json(_ value: Any) -> String {
  guard JSONSerialization.isValidJSONObject(value),
        let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else { return "null" }
  return text
}

func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func regex(_ pattern: String) -> NSRegularExpression {
  return try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

func matches(_ re: NSRegularExpression, _ text: String) -> Bool {
  return re.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
}

// MARK: - other AIs, browsers, games

// A key, what gives them away in the title of the window in front, the name of their own app if
// they have one, and the name their own site gives its pages.
typealias AI = (key: String, title: NSRegularExpression, app: String, site: String)

let AIS: [AI] = [
  ("chatgpt", regex(#"\bChatGPT\b"#), "chatgpt", "ChatGPT"),
  ("claude", regex(#"\bClaude\b"#), "claude", "Claude"),
  ("codex", regex(#"\bCodex\b"#), "codex", "Codex"),
  ("gemini", regex(#"\bGemini\b"#), "gemini", "(?:Google )?Gemini"),
  ("copilot", regex(#"\bCopilot\b"#), "copilot", "(?:Microsoft )?Copilot"),
  ("perplexity", regex(#"\bPerplexity\b"#), "perplexity", "Perplexity"),
  ("deepseek", regex(#"\bDeepSeek\b"#), "", "DeepSeek"),
  ("grok", regex(#"\bGrok\b"#), "grok", "Grok"),
  ("lechat", regex(#"\bLe Chat\b|\bMistral AI\b"#), "le chat", "Le Chat|Mistral AI"),
  ("characterai", regex(#"character\.ai"#), "", #"character\.ai"#),
  ("metaai", regex(#"\bMeta AI\b"#), "", "Meta AI"),
]

// A browser's window title is its tab's ("ChatGPT"), sometimes with its own name after it
// ("ChatGPT — Mozilla Firefox"). Their own pages have their name as a whole part of it, not inside
// a sentence ("ChatGPT is down - YouTube" is no page of theirs).
let SEP = #"(?: [-|:–—·] |: )"#
var siteCache: [String: NSRegularExpression] = [:]
func site(_ ai: AI, _ title: String) -> Bool {
  let re = siteCache[ai.key] ?? regex("(?:^|" + SEP + ")(?:" + ai.site + ")(?:" + SEP + "|$)")
  siteCache[ai.key] = re
  return matches(re, title)
}

// A page to download or install something, in her languages and a few more.
let DL = regex(#"download|t.l.charg|desc.rg|baix(?:ar|e|a|ando)|transf(?:erir|ira|ere)|herunterlad|scaric|install|setup|скач|загруз|установ"#)

func closable(_ ai: AI, _ title: String) -> Bool {
  return site(ai, title) || (matches(ai.title, title) && matches(DL, title))
}

let BROWSER_IDS: [String] = [
  "com.google.Chrome", "com.microsoft.edgemac", "org.mozilla.firefox", "org.mozilla.nightly", "com.brave.Browser",
  "com.operasoftware.Opera", "com.vivaldi.Vivaldi", "company.thebrowser.", "org.chromium.Chromium", "com.apple.Safari",
  "io.gitlab.librewolf", "net.waterfox", "one.ablaze.floorp", "app.zen-browser", "com.kagi.kagimacOS", "org.thorium",
]
let BROWSER_NAMES: Set<String> = [
  "google chrome", "microsoft edge", "firefox", "brave browser", "opera", "opera gx", "vivaldi", "arc", "dia", "chromium",
  "safari", "librewolf", "waterfox", "floorp", "zen", "zen browser", "orion", "thorium",
]

// Any app macOS would open a web link in is a browser (Comet, Helium, Orion...), whatever its name.
var webApps: Set<String> = []
var webAppsAt = Date.distantPast

func isBrowser(_ app: NSRunningApplication?) -> Bool {
  guard let app = app else { return false }
  if let id = app.bundleIdentifier, BROWSER_IDS.contains(where: { id.hasPrefix($0) }) { return true }
  if BROWSER_NAMES.contains((app.localizedName ?? "").lowercased()) { return true }
  if Date().timeIntervalSince(webAppsAt) > 60, let link = URL(string: "https://example.com") {
    webAppsAt = Date()
    webApps = Set(NSWorkspace.shared.urlsForApplications(toOpen: link).compactMap { Bundle(url: $0)?.bundleIdentifier })
  }
  return app.bundleIdentifier.map { webApps.contains($0) } ?? false
}

// Their own sites, by address: a ChatGPT conversation's tab is titled with the conversation, not "ChatGPT".
let AI_HOSTS: [(key: String, hosts: [String])] = [
  ("chatgpt", ["chatgpt.com", "chat.openai.com"]), ("claude", ["claude.ai"]), ("gemini", ["gemini.google.com", "aistudio.google.com"]),
  ("copilot", ["copilot.microsoft.com"]), ("perplexity", ["perplexity.ai"]), ("deepseek", ["chat.deepseek.com"]),
  ("grok", ["grok.com"]), ("lechat", ["chat.mistral.ai"]), ("characterai", ["character.ai"]), ("metaai", ["meta.ai"]),
]

func siteOf(_ address: String?) -> String? {
  guard let text = address, let url = URL(string: text),
        ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
        let host = url.host?.lowercased() else { return nil }
  return AI_HOSTS.first { $0.hosts.contains { host == $0 || host.hasSuffix("." + $0) } }?.key
}

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  // A timeout on the application does not apply to its window or children.
  AXUIElementSetMessagingTimeout(element, 0.1)
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func addressOf(_ value: Any?) -> String? {
  let text = (value as? URL)?.absoluteString ?? (value as? String)
  guard let text = text, let url = URL(string: text), url.host != nil,
        ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
  return text
}

// Walk the current window, never a retained web area from a previous tab. Do not enter web areas:
// an embedded AI frame on an unrelated site is not the page itself. Visible children exclude
// background tabs in browsers that expose them; ambiguous page trees are left alone.
func pageAddress<Element>(_ window: Element, read: (Element, String) -> Any?,
                          children: (Element) -> [Element], expired: () -> Bool) -> (url: String?, complete: Bool) {
  if let doc = addressOf(read(window, kAXDocumentAttribute)), !expired() { return (doc, true) }
  var queue: [(Element, Int)] = [(window, 0)]
  var index = 0
  var found: String?
  while index < queue.count && index < 500 && !expired() {
    let (element, depth) = queue[index]
    index += 1
    if (read(element, "AXHidden") as? Bool) == true { continue }
    if (read(element, kAXRoleAttribute) as? String) == "AXWebArea" {
      guard let url = addressOf(read(element, kAXURLAttribute)) else { return (nil, false) }
      if let other = found, other != url { return (nil, false) }
      found = url
      continue
    }
    let next = children(element)
    if !next.isEmpty {
      if depth >= 16 || queue.count + next.count > 500 { return (nil, false) }
      queue += next.map { ($0, depth + 1) }
    }
  }
  return expired() ? (nil, false) : (found, true)
}

var manual: Set<pid_t> = []
var address: String?
var addressWin = 0
var addressPid: pid_t = 0
var addressAt = Date.distantPast
var addressTimedOut = false
var addressComplete = true

func frontAddress(_ fg: Win?, fresh: Bool = false) -> String? {
  guard let fg = fg, AXIsProcessTrusted() else { addressComplete = false; return nil }
  if !fresh && fg.id == addressWin && fg.pid == addressPid && Date().timeIntervalSince(addressAt) < 0.5 { return address }
  addressWin = fg.id
  addressPid = fg.pid
  addressAt = Date()
  address = nil
  addressTimedOut = false
  addressComplete = false
  // Leave time for the watcher's three-second request timeout, even for an unresponsive browser.
  let deadline = ProcessInfo.processInfo.systemUptime + 0.7
  let expired = { () -> Bool in ProcessInfo.processInfo.systemUptime >= deadline }
  let read = { (element: AXUIElement, attribute: String) -> Any? in
    return expired() ? nil : axValue(element, attribute)
  }
  let app = AXUIElementCreateApplication(fg.pid)
  AXUIElementSetMessagingTimeout(app, 0.1)
  if !manual.contains(fg.pid) {
    if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success {
      manual.insert(fg.pid)
    }
  }
  guard let w = read(app, kAXFocusedWindowAttribute), CFGetTypeID(w as CFTypeRef) == AXUIElementGetTypeID() else {
    addressTimedOut = expired()
    return nil
  }
  let win = w as! AXUIElement
  let result = pageAddress(win, read: read, children: { element in
    return (read(element, kAXVisibleChildrenAttribute) as? [AXUIElement])
      ?? (read(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
  }, expired: expired)
  address = result.url
  addressComplete = result.complete
  addressTimedOut = expired()
  return address
}

// An address, when available, takes precedence over words in a conversation's title.
func detectsAI(_ title: String, name: String, browser: Bool, address: String?) -> (keys: [String], pages: [String], download: Bool) {
  if browser, let key = siteOf(address) { return ([key], [key], false) }
  let keys = AIS.filter { matches($0.title, title) || (!$0.app.isEmpty && name == $0.app) }.map { $0.key }
  let pages = browser && address == nil ? AIS.filter { keys.contains($0.key) && site($0, title) }.map { $0.key } : []
  return (keys, pages, browser && !keys.isEmpty && matches(DL, title))
}

func canClosePage(_ key: String, title: String, address: String?) -> Bool {
  guard let ai = AIS.first(where: { $0.key == key }) else { return false }
  if let site = siteOf(address) { return site == key }
  // Download pages can be on another site; otherwise a known non-AI address overrides the title.
  return address == nil ? closable(ai, title) : matches(ai.title, title) && matches(DL, title)
}

// A game: its program sits in a launcher's library (Steam, Epic, GOG). The game is the name of its
// folder there (the launchers themselves aren't games).
let GAME = regex(#"/(?:steamapps/common|Epic Games|GOG Games|GOG Galaxy/Games)/([^/]+)/"#)
let NOT_GAME = regex(#"launcher|client|redistributable|steamworks"#)

func gameOf(_ app: NSRunningApplication?) -> String? {
  guard let path = (app?.bundleURL ?? app?.executableURL)?.path else { return nil }
  let range = NSRange(path.startIndex..., in: path)
  guard let m = GAME.firstMatch(in: path, options: [], range: range), let r = Range(m.range(at: 1), in: path) else { return nil }
  let name = String(path[r])
  return matches(NOT_GAME, name) ? nil : name
}

// MARK: - windows

struct Win {
  let id: Int
  let pid: pid_t
  let rect: CGRect
  let name: String?
}

// what's never a window to sit on: the system's own pieces
let SYSTEM_OWNERS: Set<String> = [
  "Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center", "Spotlight",
  "WindowManager", "Screenshot", "screencaptureui", "loginwindow", "TextInputMenuAgent",
]

func windowList(skip overlay: Int) -> [Win] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return []
  }
  var wins: [Win] = []
  for w in list {
    // normal windows, floating ones (always on top) and modal panels; not the Dock, the menu bar, Capri
    let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
    guard layer >= 0 && layer <= 8 else { continue }
    guard let id = w[kCGWindowNumber as String] as? Int, id != overlay,
          let pid = w[kCGWindowOwnerPID as String] as? Int else { continue }
    if let owner = w[kCGWindowOwnerName as String] as? String, SYSTEM_OWNERS.contains(owner) { continue }
    if let alpha = w[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
    guard let b = w[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: b as CFDictionary) else { continue }
    wins.append(Win(id: id, pid: pid_t(pid), rect: rect, name: w[kCGWindowName as String] as? String))
  }
  return wins
}

// The title of the focused window of app `pid`, through Accessibility (only if Capri may use it).
func axTitle(_ pid: pid_t) -> String? {
  guard AXIsProcessTrusted() else { return nil }
  let app = AXUIElementCreateApplication(pid)
  guard let win = axValue(app, kAXFocusedWindowAttribute), CFGetTypeID(win) == AXUIElementGetTypeID() else { return nil }
  return axValue(win as! AXUIElement, kAXTitleAttribute) as? String
}

// MARK: - USB sticks and devices

let daSession = DASessionCreate(kCFAllocatorDefault)

// USB sticks and SD cards mounted, by volume name (not disk images, not the Mac's own disks).
func usbVolumes() -> [String] {
  guard let session = daSession else { return [] }
  let keys: [URLResourceKey] = [.volumeNameKey]
  let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? []
  var names: [String] = []
  for url in urls {
    guard let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, url as CFURL),
          let desc = DADiskCopyDescription(disk) as? [String: Any] else { continue }
    let proto = (desc[kDADiskDescriptionDeviceProtocolKey as String] as? String) ?? ""
    let isInternal = (desc[kDADiskDescriptionDeviceInternalKey as String] as? Bool) ?? true
    guard (proto == "USB" && !isInternal) || proto.contains("Secure Digital") else { continue }
    let name = (try? url.resourceValues(forKeys: [.volumeNameKey]))?.volumeName
    names.append(name ?? url.lastPathComponent)
  }
  return names.sorted()
}

var usbNow: [String] = []
var usbAt = Date.distantPast

func usb() -> [String] {
  if Date().timeIntervalSince(usbAt) >= 2 {
    usbAt = Date()
    usbNow = usbVolumes()
  }
  return usbNow
}

// Devices plugged in or out (a phone, a controller, a headset...): IOKit tells us; we keep what each
// one is called and what kind of device it is, as Windows would name its class.
struct Device {
  let name: String
  let cls: String
}

var devices: [UInt64: Device] = [:]
var pendingIn: [io_object_t] = []
var pendingOut: [Device] = []
var plugs = 0
var plug: Any = NSNull()
var plugTimer: Timer?

func property(_ service: io_object_t, _ key: String) -> Any? {
  return IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
}

func describe(_ service: io_object_t) -> Device {
  var name = (property(service, "USB Product Name") as? String) ?? (property(service, "kUSBProductString") as? String) ?? ""
  if name.isEmpty {
    var buf = [CChar](repeating: 0, count: 128)
    if IORegistryEntryGetName(service, &buf) == KERN_SUCCESS { name = String(cString: buf) }
  }
  var interfaces = Set<Int>()
  var iterator: io_iterator_t = 0
  if IORegistryEntryCreateIterator(service, kIOServicePlane, IOOptionBits(kIORegistryIterateRecursively), &iterator) == KERN_SUCCESS {
    var child = IOIteratorNext(iterator)
    while child != 0 {
      if let c = property(child, "bInterfaceClass") as? Int { interfaces.insert(c) }
      IOObjectRelease(child)
      child = IOIteratorNext(iterator)
    }
    IOObjectRelease(iterator)
  }
  let deviceClass = (property(service, "bDeviceClass") as? Int) ?? 0
  var cls = "USB"
  if matches(regex(#"iphone|ipad|android|phone|pixel|galaxy"#), name) { cls = "WPD" }
  else if deviceClass == 9 { cls = "Hub" }
  else if interfaces.contains(1) { cls = "AudioEndpoint" }
  else if interfaces.contains(14) { cls = "Camera" }
  else if interfaces.contains(6) { cls = "Image" }
  else if interfaces.contains(8) { cls = "DiskDrive" }
  else if interfaces.contains(3) { cls = "HIDClass" }
  else if interfaces.contains(0xE0) || deviceClass == 0xE0 { cls = "Bluetooth" }
  return Device(name: name, cls: cls)
}

func entryID(_ service: io_object_t) -> UInt64 {
  var id: UInt64 = 0
  IORegistryEntryGetRegistryEntryID(service, &id)
  return id
}

// The device that says the most about what was plugged: "Galaxy S21" rather than "USB2.0 Hub".
let VAGUE = regex(#"composite|hub|input device|hid|mass storage|generic|virtu|interface|host|bus|port|endpoint|service|receiver|billboard|controller$"#)
func best(_ list: [Device]) -> Device? {
  var top = Int.min
  var found: Device?
  for d in list where !d.name.isEmpty && d.cls != "Hub" {
    var score: Int
    switch d.cls {
    case "WPD": score = 6
    case "AudioEndpoint": score = 5
    case "Camera", "Image": score = 4
    case "HIDClass": score = 3
    case "Bluetooth": score = 2
    default: score = 1
    }
    if matches(VAGUE, d.name) { score -= 4 }
    if score > top { top = score; found = d }
  }
  return found
}

// a phone shows up as several devices, one after the other: once things settle, the best of them
func settle() {
  plugTimer?.invalidate()
  plugTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { _ in
    let added = pendingIn.map { service -> Device in
      let d = describe(service)
      devices[entryID(service)] = d
      IOObjectRelease(service)
      return d
    }
    let removed = pendingOut
    pendingIn = []
    pendingOut = []
    let plugged = !added.isEmpty
    guard let d = best(plugged ? added : removed) else { return }
    plugs += 1
    plug = ["n": plugs, "in": plugged, "name": d.name, "class": d.cls]
  }
}

let deviceAdded: IOServiceMatchingCallback = { _, iterator in
  var service = IOIteratorNext(iterator)
  while service != 0 {
    pendingIn.append(service) // released once looked at
    service = IOIteratorNext(iterator)
  }
  settle()
}

let deviceRemoved: IOServiceMatchingCallback = { _, iterator in
  var service = IOIteratorNext(iterator)
  while service != 0 {
    if let d = devices.removeValue(forKey: entryID(service)) { pendingOut.append(d) }
    IOObjectRelease(service)
    service = IOIteratorNext(iterator)
  }
  if !pendingOut.isEmpty { settle() }
}

func watchDevices() {
  guard let port = IONotificationPortCreate(kIOMainPortDefault) else { return }
  IONotificationPortSetDispatchQueue(port, DispatchQueue.main)
  var added: io_iterator_t = 0
  if IOServiceAddMatchingNotification(port, kIOFirstMatchNotification, IOServiceMatching("IOUSBHostDevice"), deviceAdded, nil, &added) == KERN_SUCCESS {
    // what's already plugged in: known, not news
    var service = IOIteratorNext(added)
    while service != 0 {
      devices[entryID(service)] = describe(service)
      IOObjectRelease(service)
      service = IOIteratorNext(added)
    }
  }
  var removed: io_iterator_t = 0
  if IOServiceAddMatchingNotification(port, kIOTerminatedNotification, IOServiceMatching("IOUSBHostDevice"), deviceRemoved, nil, &removed) == KERN_SUCCESS {
    var service = IOIteratorNext(removed)
    while service != 0 {
      IOObjectRelease(service)
      service = IOIteratorNext(removed)
    }
  }
}

// MARK: - keys

// The key that types `char` on the keyboard layout in use (⌘W is not on the same key in AZERTY),
// else its place on a US keyboard (layouts with no Latin letters use that one for shortcuts).
func keyCode(_ char: String, fallback: CGKeyCode) -> CGKeyCode {
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return fallback }
  let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue()
  guard let bytes = CFDataGetBytePtr(data) else { return fallback }
  let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
  for modifiers in [UInt32((cmdKey >> 8) & 0xFF), 0] {
    for code in 0..<128 {
      var dead: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, UInt32(LMGetKbdType()),
                                  OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, 4, &length, &chars)
      if status == noErr && length > 0 && String(utf16CodeUnits: chars, count: length).lowercased() == char {
        return CGKeyCode(code)
      }
    }
  }
  return fallback
}

func press(_ code: CGKeyCode, flags: CGEventFlags, pid: pid_t) -> Bool {
  let source = CGEventSource(stateID: .hidSystemState)
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
  for event in [down, up] {
    event.flags = flags
    // A last-instant focus change must never send ⌘W to Capri (or another app).
    event.postToPid(pid)
  }
  return true
}

// The media keys, as if pressed on the keyboard: whatever plays music reacts.
func mediaKey(_ key: Int) -> Bool {
  guard AXIsProcessTrusted() else { return false }
  for down in [true, false] {
    let flags = NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00)
    let data1 = (key << 16) | ((down ? 0xa : 0xb) << 8)
    let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                                   windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)
    event?.cgEvent?.post(tap: .cghidEventTap)
  }
  return true
}

// MARK: - the watch

var capriPid: pid_t = 0
var overlayId = 0
var frontPid: pid_t = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
var lastFg = 0
var lastSnap = ""
var title: String?
var titleOf = 0
var titleAt = Date.distantPast

func front() -> NSRunningApplication? {
  return NSRunningApplication(processIdentifier: frontPid)
}

// The title of the window in front: its name in the window list when macOS gives it (Screen
// Recording allowed), else through Accessibility, looked at twice a second at most.
func frontTitle(_ fg: Win?) -> String {
  guard let fg = fg else { return "" }
  if let name = fg.name, !name.isEmpty { return name }
  if fg.id != titleOf || Date().timeIntervalSince(titleAt) > 0.5 {
    titleOf = fg.id
    titleAt = Date()
    title = axTitle(fg.pid)
  }
  return title ?? ""
}

func snapshot() -> (String, Win?) {
  let wins = windowList(skip: overlayId)
  let app = front()
  // the window in front: the frontmost app's first window (Capri's own overlay when it's her)
  let fg = wins.first { $0.pid == frontPid }
  var fgId = fg?.id ?? 0
  if fg == nil && frontPid == capriPid { fgId = overlayId }
  let t = frontTitle(fg)
  let name = (app?.localizedName ?? "").lowercased()
  let browser = isBrowser(app)
  let page = browser ? frontAddress(fg) : nil
  let detected = detectsAI(t, name: name, browser: browser && addressComplete, address: page)
  var list: [[String: Any]] = []
  for w in wins.prefix(40) {
    if w.rect.width < 200 || w.rect.height < 120 { continue }
    list.append(["id": w.id, "x": Int(w.rect.origin.x), "y": Int(w.rect.origin.y), "w": Int(w.rect.width), "h": Int(w.rect.height), "pid": Int(w.pid)])
  }
  let snap: [String: Any] = [
    "fg": fgId, "fgPid": Int(frontPid), "taskbar": false, "ai": detected.keys, "pages": detected.pages, "dl": detected.download,
    "game": gameOf(app).map { $0 as Any } ?? NSNull(), "usb": usb(), "plug": plug, "wins": list,
  ]
  return (json(snap), fg)
}

func tick() {
  let (snap, _) = snapshot()
  if snap != lastSnap {
    lastSnap = snap
    emit(snap)
  }
  // stop with Capri, even if she crashed without telling us
  if capriPid > 0 && kill(capriPid, 0) != 0 && errno == ESRCH { exit(0) }
}

// She closes that AI's page in window `id` with the browser's own shortcut for its tab (⌘W), if it
// still is that page, in that window, in front, in a browser, and no Shift, Option or Control is held
// (⌘⇧W would close the whole window). "" once done, else why not.
func closePage(_ id: Int, _ key: String) -> String {
  guard AXIsProcessTrusted() else { return "access" }
  guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != capriPid else { return "front" }
  let pid = app.processIdentifier
  let wins = windowList(skip: overlayId)
  guard let fg = wins.first(where: { $0.pid == pid }), fg.id == id else { return "front" }
  guard isBrowser(app) else { return "browser" }
  titleAt = Date.distantPast
  let currentAddress = frontAddress(fg, fresh: true)
  if addressTimedOut { return "late" }
  if !addressComplete { return "page" }
  guard canClosePage(key, title: frontTitle(fg), address: currentAddress) else { return "page" }
  let code = keyCode("w", fallback: 13)
  // Accessibility may have taken time. Check the live foreground again, not the last timer tick.
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
        windowList(skip: overlayId).first(where: { $0.pid == pid })?.id == id else { return "front" }
  let held = CGEventSource.flagsState(.combinedSessionState)
  if !held.intersection([.maskShift, .maskAlternate, .maskControl, .maskCommand]).isEmpty { return "keys" }
  guard AXIsProcessTrusted() else { return "access" }
  let sent = press(code, flags: .maskCommand, pid: pid)
  addressAt = Date.distantPast
  titleAt = Date.distantPast
  return sent ? "" : "error"
}

func listenForAsks() {
  Thread.detachNewThread {
    while let line = readLine() {
      let ask = line.split(separator: " ").map(String.init)
      guard ask.count == 4, ask[0] == "close", let id = Int(ask[1]), let n = Int(ask[3]) else { continue }
      DispatchQueue.main.async {
        emit(json(["closed": n, "why": closePage(id, ask[2])]))
      }
    }
    exit(0) // our input closed: Capri is gone
  }
}

func watch() {
  _ = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
      frontPid = app.processIdentifier
    }
  }
  watchDevices()
  listenForAsks()
  tick()
  Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
    // the activation notice can be late or missed: the frontmost app as macOS has it now
    if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier { frontPid = pid }
    tick()
  }
  RunLoop.main.run()
}

// MARK: - one-off commands

// never these: Finder, her (Capri), the AIs she watches and talks through
let KEEP: Set<String> = ["finder", "capri", "electron", "claude", "codex", "ollama", "loginwindow", "dock", "systemuiserver"]

func regularApps(except pid: pid_t) -> [NSRunningApplication] {
  return NSWorkspace.shared.runningApplications.filter {
    $0.activationPolicy == .regular && $0.processIdentifier != pid && $0.processIdentifier != getpid() && !$0.isTerminated
  }
}

func apps(_ skip: pid_t) {
  var out: [[String: Any]] = []
  for app in regularApps(except: skip) {
    let name = app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? ""
    if name.isEmpty || KEEP.contains(name.lowercased()) { continue }
    out.append(["id": Int(app.processIdentifier), "name": name, "label": name, "bundle": app.bundleIdentifier ?? ""])
  }
  emit(json(out))
}

func spin(_ seconds: Double) {
  RunLoop.main.run(until: Date().addingTimeInterval(seconds))
}

func quit(_ pids: [pid_t], force: Bool) {
  let targets = pids.compactMap { NSRunningApplication(processIdentifier: $0) }
  for app in targets {
    if force { app.forceTerminate() } else { app.terminate() }
  }
  spin(force ? 0.6 : 2.5)
  emit(String(targets.filter { !$0.isTerminated }.count))
}

func place(_ pid: pid_t, _ frame: CGRect) {
  guard AXIsProcessTrusted() else { return emit("access") }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 1)
  var value: CFTypeRef?
  var win: AXUIElement?
  if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success, let v = value {
    win = (v as! AXUIElement)
  } else if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
            let list = value as? [AXUIElement], let first = list.first {
    win = first
  }
  guard let w = win else { return emit("none") }
  AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
  var origin = frame.origin
  var size = frame.size
  if let p = AXValueCreate(.cgPoint, &origin), let s = AXValueCreate(.cgSize, &size) {
    AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, p)
    AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, s)
    AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, p) // again, once its size let it get there
  }
  _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  emit("ok")
}

func lockScreen() {
  // what the Apple menu's Lock Screen does
  if let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
     let symbol = dlsym(handle, "SACLockScreenImmediate") {
    typealias Lock = @convention(c) () -> Int32
    _ = unsafeBitCast(symbol, to: Lock.self)()
    return emit("ok")
  }
  emit("none")
}

// MARK: - main

#if !CAPRI_TESTS

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""
let number = { (i: Int) -> Int in args.count > i ? (Int(args[i]) ?? 0) : 0 }

switch command {
case "watch":
  capriPid = pid_t(number(2))
  overlayId = number(3)
  watch()
case "apps":
  apps(pid_t(number(2)))
case "quit", "kill":
  quit(args.dropFirst(2).compactMap { Int32($0) }, force: command == "kill")
case "hide":
  for app in regularApps(except: pid_t(number(2))) { _ = app.hide() }
  emit("ok")
case "unhide":
  for app in regularApps(except: 0) { _ = app.unhide() }
  emit("ok")
case "place":
  place(pid_t(number(2)), CGRect(x: number(3), y: number(4), width: number(5), height: number(6)))
case "activate":
  let ok = NSRunningApplication(processIdentifier: pid_t(number(2)))?.activate(options: []) ?? false
  emit(ok ? "ok" : "none")
case "media":
  let keys = ["play": 16, "pause": 16, "next": 17, "previous": 18]
  emit(keys[args.count > 2 ? args[2] : ""].map { mediaKey($0) ? "ok" : "access" } ?? "none")
case "lock":
  lockScreen()
case "trusted":
  let prompt = args.count > 2 && args[2] == "prompt"
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
  emit(json(["trusted": AXIsProcessTrustedWithOptions(options)]))
default:
  FileHandle.standardError.write("usage: capri-helper watch|apps|quit|kill|hide|unhide|place|activate|media|lock|trusted\n".data(using: .utf8)!)
  exit(2)
}

#endif
