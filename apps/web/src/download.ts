/** Hands `data` to the browser as a file to save under `name`. */
export function download(data: BlobPart, name: string, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The browser may start the download only after click() has returned: the URL must outlive it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
