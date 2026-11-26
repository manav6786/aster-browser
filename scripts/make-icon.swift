import AppKit
let output = CommandLine.arguments[1]
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let rect = NSRect(x: 32, y: 32, width: 960, height: 960)
let shape = NSBezierPath(roundedRect: rect, xRadius: 220, yRadius: 220)
NSGradient(colors: [NSColor(red: 0.75, green: 0.69, blue: 1, alpha: 1), NSColor(red: 0.37, green: 0.28, blue: 0.81, alpha: 1), NSColor(red: 0.23, green: 0.22, blue: 0.53, alpha: 1)])!.draw(in: shape, angle: -75)
NSColor.white.withAlphaComponent(0.32).setStroke()
shape.lineWidth = 5
shape.stroke()
let orbit = NSBezierPath(ovalIn: NSRect(x: 174, y: 248, width: 676, height: 528))
let transform = AffineTransform(translationByX: 512, byY: 512)
var rotate = transform
rotate.rotate(byDegrees: 30)
rotate.translate(x: -512, y: -512)
orbit.transform(using: rotate)
NSColor.white.withAlphaComponent(0.3).setStroke()
orbit.lineWidth = 3
orbit.stroke()
let star = NSBezierPath()
star.move(to: NSPoint(x: 512, y: 820))
star.curve(to: NSPoint(x: 796, y: 512), controlPoint1: NSPoint(x: 552, y: 590), controlPoint2: NSPoint(x: 578, y: 552))
star.curve(to: NSPoint(x: 512, y: 204), controlPoint1: NSPoint(x: 578, y: 472), controlPoint2: NSPoint(x: 552, y: 434))
star.curve(to: NSPoint(x: 228, y: 512), controlPoint1: NSPoint(x: 472, y: 434), controlPoint2: NSPoint(x: 446, y: 472))
star.curve(to: NSPoint(x: 512, y: 820), controlPoint1: NSPoint(x: 446, y: 552), controlPoint2: NSPoint(x: 472, y: 590))
star.close()
NSColor.white.withAlphaComponent(0.95).setFill()
star.fill()
let glint = NSBezierPath(ovalIn: NSRect(x: 748, y: 735, width: 28, height: 28))
NSColor.white.withAlphaComponent(0.8).setFill()
glint.fill()
image.unlockFocus()
let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
