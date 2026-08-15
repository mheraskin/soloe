#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) {
      fprintf(stderr, "usage: pad-macos-icon <input.png> <output.png>\n");
      return 2;
    }

    NSString *inputPath = [NSString stringWithUTF8String:argv[1]];
    NSString *outputPath = [NSString stringWithUTF8String:argv[2]];
    NSImage *source = [[NSImage alloc] initWithContentsOfFile:inputPath];
    if (source == nil) {
      fprintf(stderr, "failed to load input image\n");
      return 1;
    }

    const NSInteger canvasSize = 1024;
    const CGFloat artworkSize = 824.0;
    const CGFloat inset = (canvasSize - artworkSize) / 2.0;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
      pixelsWide:canvasSize
      pixelsHigh:canvasSize
      bitsPerSample:8
      samplesPerPixel:4
      hasAlpha:YES
      isPlanar:NO
      colorSpaceName:NSCalibratedRGBColorSpace
      bytesPerRow:0
      bitsPerPixel:0];
    if (bitmap == nil) return 1;

    memset(bitmap.bitmapData, 0, bitmap.bytesPerRow * bitmap.pixelsHigh);
    NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    context.imageInterpolation = NSImageInterpolationHigh;
    [source drawInRect:NSMakeRect(inset, inset, artworkSize, artworkSize)
              fromRect:NSMakeRect(0, 0, source.size.width, source.size.height)
             operation:NSCompositingOperationSourceOver
              fraction:1.0
        respectFlipped:NO
                 hints:nil];
    [context flushGraphics];
    [NSGraphicsContext restoreGraphicsState];

    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (![png writeToFile:outputPath atomically:YES]) {
      fprintf(stderr, "failed to write output image\n");
      return 1;
    }
    if ([bitmap colorAtX:0 y:0].alphaComponent != 0.0) {
      fprintf(stderr, "output corner is not transparent\n");
      return 1;
    }
  }
  return 0;
}
