import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let factor = CGFloat(pixels) / 24
        let transform = NSAffineTransform(); transform.scale(by: factor); transform.concat()
        NSColor(calibratedRed:0.05,green:0.067,blue:0.09,alpha:1).setFill()
        NSBezierPath(roundedRect:NSRect(x:0,y:0,width:24,height:24),xRadius:5,yRadius:5).fill()
        NSColor(calibratedRed:0.204,green:0.827,blue:0.6,alpha:1).setStroke()
        let line = NSBezierPath(); line.lineWidth = 1.6
        line.move(to:NSPoint(x:7.4,y:13));line.line(to:NSPoint(x:15.9,y:17.6))
        line.move(to:NSPoint(x:7.4,y:11));line.line(to:NSPoint(x:15.9,y:6.4));line.stroke()
        for (x,y,r,color) in [(5.5,12.0,2.6,NSColor(calibratedRed:0.204,green:0.827,blue:0.6,alpha:1)),(18.0,18.5,2.2,NSColor(calibratedRed:0.85,green:0.467,blue:0.341,alpha:1)),(18.0,5.5,2.2,NSColor(calibratedRed:0.655,green:0.545,blue:0.98,alpha:1))] {
            color.setFill(); NSBezierPath(ovalIn:NSRect(x:x-r,y:y-r,width:r*2,height:r*2)).fill()
        }
        image.unlockFocus()
        let png = NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!
        try png.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
