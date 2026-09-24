// Names for pasted images. Screenshots and copied images arrive as "image.png" (or with no name);
// those get a timestamp like Typora's, so each paste is its own file. A real file name is kept.

const extensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

export function isInsertableImage(type: string) {
  return type in extensions;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function pastedImageName(name: string, type: string, now: Date): string {
  const ext = extensions[type] ?? "png";
  if (name && !/^image\.[a-z]+$/i.test(name) && /\.[a-z0-9]+$/i.test(name)) return name;
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `image-${stamp}.${ext}`;
}
