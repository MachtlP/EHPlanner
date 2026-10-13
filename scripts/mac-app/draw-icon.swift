import AppKit

func color(_ hex: UInt32) -> NSColor {
  NSColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: 1
  )
}

let side: CGFloat = 1024
let image = NSImage(size: NSSize(width: side, height: side))
image.lockFocus()

let canvas = NSRect(x: 0, y: 0, width: side, height: side)
color(0xEFEAE2).setFill()
canvas.fill()

let inset: CGFloat = 118
let gap: CGFloat = 36
let grid = canvas.insetBy(dx: inset, dy: inset)
let cell = (grid.width - gap) / 2
// Visual order matches the matrix: Do, Schedule / Hand off, Later.
// AppKit origin is the bottom left.
let cells: [(CGFloat, CGFloat, UInt32)] = [
  (grid.minX, grid.minY + cell + gap, 0x9D3D2F),
  (grid.minX + cell + gap, grid.minY + cell + gap, 0x24598A),
  (grid.minX, grid.minY, 0x8A5810),
  (grid.minX + cell + gap, grid.minY, 0x5E655C),
]
for (x, y, hex) in cells {
  let rect = NSRect(x: x, y: y, width: cell, height: cell)
  let path = NSBezierPath(roundedRect: rect, xRadius: 72, yRadius: 72)
  color(hex).setFill()
  path.fill()
}

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  fputs("Could not draw the icon.\n", stderr)
  exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
