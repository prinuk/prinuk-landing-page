import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3 else {
  fputs("Usage: update-price-template-image.swift input.png output.png\n", stderr)
  exit(2)
}

let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard let image = NSImage(contentsOf: inputURL),
      let source = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fputs("Could not read input image\n", stderr)
  exit(1)
}

let width = source.width
let height = source.height
let size = NSSize(width: width, height: height)
let output = NSImage(size: size)

output.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high

NSImage(cgImage: source, size: size).draw(in: NSRect(origin: .zero, size: size))

let coverRect = NSRect(x: 300, y: 0, width: 620, height: 78)
NSColor(red: 0.985, green: 0.972, blue: 0.932, alpha: 1).setFill()
NSBezierPath(roundedRect: coverRect, xRadius: 18, yRadius: 18).fill()

let text = "053-5234975"
let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .center

let labelAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont(name: "Arial-BoldMT", size: 30) ?? NSFont.boldSystemFont(ofSize: 30),
  .foregroundColor: NSColor(red: 0.02, green: 0.29, blue: 0.09, alpha: 1),
  .paragraphStyle: paragraph,
]
let labelRect = NSRect(x: 398, y: 78, width: 486, height: 38)
"לפרטים והזמנות:".draw(in: labelRect, withAttributes: labelAttrs)

let font = NSFont(name: "Arial-BoldMT", size: 66) ?? NSFont.boldSystemFont(ofSize: 66)
let attrs: [NSAttributedString.Key: Any] = [
  .font: font,
  .foregroundColor: NSColor(red: 0.02, green: 0.29, blue: 0.09, alpha: 1),
  .paragraphStyle: paragraph,
  .kern: 1.0,
]

let textRect = NSRect(x: 398, y: 6, width: 486, height: 72)
text.draw(in: textRect, withAttributes: attrs)

output.unlockFocus()

guard let tiff = output.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Could not encode output image\n", stderr)
  exit(1)
}

try png.write(to: outputURL)
