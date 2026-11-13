import { expect, test, type Page } from "@playwright/test";

/** Opens the app on the demo PLC and waits until its components are discovered. */
async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("Gateway: open");
  await expect(page.locator(".statusbar")).toContainText("PLC: connected");
  await expect(page.locator("main.viewport canvas")).toBeVisible();
}

/** Every uncaught error in the page fails the test that saw it. */
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("shows the demo machine: 3D view, component tree and the release version", async ({ page }) => {
  await openApp(page);
  // E.g. v0.1.0+aa29151 (package.json version and commit) or v1.2.3 from a release tag.
  await expect(page.locator(".statusbar .statusbar-version")).toHaveText(/^v\d+\.\d+\.\d+/);
  // Below 1600 px the components panel starts closed and the inspector always does.
  await expect(page.locator("aside.panel.left")).toBeHidden();
  await expect(page.locator("aside.panel.right")).toBeHidden();

  await page.getByRole("button", { name: "Show components" }).click();
  const tree = page.locator("aside.panel.left .tree");
  await expect(tree).toContainText("Delta 1");
  await expect(tree).toContainText("Infeed");
});

test("opens, resizes and closes the side panels, and keeps them across a reload", async ({ page }) => {
  await openApp(page);
  const panel = page.locator("aside.panel.left");
  const viewport = page.locator("main.viewport");

  await page.getByRole("button", { name: "Show components" }).click();
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())!.width;

  // Grabbed near the top: the middle of the edge is the panel handle.
  const edge = (await page.getByLabel("Resize components").boundingBox())!;
  const grab = { x: edge.x + edge.width / 2, y: edge.y + 60 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 120, grab.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 100);
  const resized = (await panel.boundingBox())!.width;

  await page.reload();
  await openApp(page);
  await expect(panel).toBeVisible();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(Math.round(resized));

  // Closed after resizing, the 3D view takes the whole width again (no black bar where the panel was).
  await page.getByRole("button", { name: "Hide components" }).click();
  await expect(panel).toBeHidden();
  await expect.poll(async () => (await viewport.boundingBox())!.x).toBe(0);

  await page.getByRole("button", { name: "Show inspector" }).click();
  await expect(page.locator("aside.panel.right")).toBeVisible();
  await page.reload();
  await openApp(page);
  await expect(page.locator("aside.panel.right")).toBeVisible();
  await expect(panel).toBeHidden();
});

test("switches between the camera views", async ({ page }) => {
  await openApp(page);
  const canvas = page.locator("main.viewport canvas");
  const views = page.getByRole("toolbar", { name: "Camera" }).getByRole("button");
  await expect(views).toHaveCount(4);

  await page.getByRole("button", { name: "View from above" }).click();
  await page.waitForTimeout(800);
  const top = await canvas.screenshot();
  await page.getByRole("button", { name: "View from the side (along +X)" }).click();
  await page.waitForTimeout(800);
  const side = await canvas.screenshot();
  expect(side.equals(top)).toBe(false);
  await page.getByRole("button", { name: "Isometric view of the whole machine" }).click();
  await expect(canvas).toBeVisible();
});

test.describe("measuring", () => {
  test.use({ hasTouch: true });

  test("measures between two snap points", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "View from above" }).click();
    await page.keyboard.press("m");
    await expect(page.locator(".measure-hint")).toBeVisible();

    // A tap snaps to the nearest snap point within 40 px: tap a grid from the middle outwards until two are taken.
    const box = (await page.locator("main.viewport canvas").boundingBox())!;
    const rows = page.locator(".measure-points li");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const taps: { x: number; y: number }[] = [];
    for (let x = box.x + 30; x < box.x + box.width - 30; x += 50) {
      for (let y = box.y + 30; y < box.y + box.height - 30; y += 50) taps.push({ x, y });
    }
    taps.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    for (const tap of taps) {
      if ((await rows.count()) >= 2) break;
      await page.touchscreen.tap(tap.x, tap.y);
    }

    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("MCS");
    await expect(rows.nth(1)).toContainText("ΔX");

    await page.getByRole("button", { name: "Clear points" }).click();
    await expect(rows).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".measure-hint")).toBeHidden();
  });
});

test("records, plays back, seeks, saves and opens a recording", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Stop recording" }).click();

  // After stopping, the bar opens in playback at the start.
  const bar = page.getByRole("toolbar", { name: "Playback" });
  await expect(bar).toBeVisible();
  await expect(page.locator(".playback-banner")).toBeVisible();
  const slider = bar.getByLabel("Playback position");
  const duration = Number(await slider.getAttribute("max"));
  expect(duration).toBeGreaterThan(2000);

  await bar.getByRole("button", { name: "Play" }).click();
  await expect(bar.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
  await bar.getByRole("button", { name: "Pause" }).click();

  await slider.fill(String(Math.round(duration / 2)));
  await expect(page.locator(".player-time")).toContainText(" / ");
  expect(Math.abs(Number(await slider.inputValue()) - duration / 2)).toBeLessThan(50);

  const downloading = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Save" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^rpp-recording-\d{8}-\d{6}\.rpprec$/);
  const file = await download.path();

  await bar.getByRole("button", { name: "Live" }).click();
  await expect(page.locator(".playback-banner")).toBeHidden();
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar.getByRole("button", { name: "Play" })).toBeDisabled();

  await page.locator('input[type="file"][accept=".rpprec"]').setInputFiles(file);
  await expect(page.locator(".playback-banner")).toBeVisible();
  await expect.poll(async () => Number(await slider.getAttribute("max"))).toBe(duration);
});

test("replays the last minute from the replay buffer and saves it", async ({ page }) => {
  await openApp(page);
  const replay = page.getByRole("button", { name: "Replay the last minute" });
  await page.waitForTimeout(3000);
  await replay.click();

  // The buffer has run since the page opened: the recording covers about that time.
  const bar = page.getByRole("toolbar", { name: "Playback" });
  await expect(page.locator(".playback-banner")).toBeVisible();
  const slider = bar.getByLabel("Playback position");
  const duration = Number(await slider.getAttribute("max"));
  expect(duration).toBeGreaterThan(2000);
  await bar.getByRole("button", { name: "Play" }).click();
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);

  const downloading = page.waitForEvent("download");
  await bar.getByRole("button", { name: "Save" }).click();
  expect((await downloading).suggestedFilename()).toMatch(/^rpp-recording-\d{8}-\d{6}\.rpprec$/);

  // Still allowed during playback, and not while recording.
  await expect(replay).toBeEnabled();
  await bar.getByRole("button", { name: "Live" }).click();
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(replay).toBeDisabled();
  await page.getByRole("button", { name: "Stop recording" }).click();
});

test("keeps layers, hidden components and the camera across a reload", async ({ page }) => {
  await openApp(page);
  const storedCamera = () =>
    page.evaluate(() => (JSON.parse(localStorage.getItem("rpp.view") ?? "{}") as { camera?: unknown }).camera);

  await page.getByRole("button", { name: "Zones", exact: true }).click();
  await page.getByRole("button", { name: "Show components" }).click();
  await page.getByRole("button", { name: "Hide Delta 1" }).click();
  await page.getByRole("button", { name: "View from above" }).click();
  await expect.poll(storedCamera).toBeDefined();
  const top = await storedCamera();

  await page.reload();
  await openApp(page);
  await expect(page.getByRole("button", { name: "Zones", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Working areas" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Show Delta 1" })).toBeVisible();
  // Back where it was left: framing the machine again would have stored another camera.
  await page.waitForTimeout(1000);
  expect(await storedCamera()).toEqual(top);

  // A drag in the 3D view is remembered too.
  const box = (await page.locator("main.viewport canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(storedCamera).not.toEqual(top);
});

test("marks faults on the recording's timeline and jumps to them", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Show components" }).click();
  // The demo puts a component or mover in a fault for 5 s every 20 s; one active when recording starts is marked at the start.
  // Start on a fault that has just begun: one about to end may be over before the recording starts.
  // Faults only: the tree marks limit violations with the same icon, and the demo's Deltas have them often.
  const faultIcons = page.locator('aside.panel.left .fault-icon[aria-label="Fault"]');
  await expect(faultIcons).toHaveCount(0, { timeout: 10_000 });
  await expect(faultIcons.first()).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Stop recording" }).click();

  const bar = page.getByRole("toolbar", { name: "Playback" });
  await expect(bar.locator(".timeline-marker.fault").first()).toHaveAttribute("title", /Fault · /);
  // PageUp from the end goes to the last event of any kind before it (missed products and limit violations are marked
  // too): the last marker short of the end, since an event that came with the last message lies at the end itself.
  const places = await bar
    .locator(".timeline-marker")
    .evaluateAll((markers) => markers.map((m) => Number((m as HTMLElement).style.getPropertyValue("--at"))));
  const marker = bar.locator(".timeline-marker").nth(places.filter((at) => at < 1).length - 1);
  const slider = bar.getByLabel("Playback position");
  const end = Number(await slider.getAttribute("max"));

  // The slider moves in whole ms; recording times are fractional.
  await page.keyboard.press("End");
  await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(end - 1);
  await page.keyboard.press("PageUp");
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(end - 1);
  const atEvent = Number(await slider.inputValue());

  await page.keyboard.press("End");
  await marker.click();
  await expect.poll(async () => Number(await slider.inputValue())).toBe(atEvent);
});

test("lists a limit violation under its robot and marks it on the timeline", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Show components" }).click();
  // Delta 1's TCP limit area leaves its limit area for a moment whenever it picks a product near the far belt edge,
  // several times a minute: watched every frame, since it lasts only a few of them.
  const text = "Delta 1 TCP limit area leaves the limit area of Delta 1";
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("aside.panel.left .fault-lines li.limit")].some((li) => li.textContent?.includes(t)),
    text,
    { polling: "raf", timeout: 40_000 },
  );

  await page.getByRole("button", { name: "Replay the last minute" }).click();
  const bar = page.getByRole("toolbar", { name: "Playback" });
  // The other Deltas of the demo have limit violations too: Delta 1's is one of the markers.
  await expect(bar.locator(`.timeline-marker.limit[title*="Limit violation · ${text}"]`).first()).toBeAttached();
});

test("shows what happened to a selected product in the inspector", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Show inspector" }).click();
  await page.getByRole("button", { name: "View from above" }).click();
  await page.waitForTimeout(800);
  const heading = page.locator("aside.panel.right h2");

  // Products move: click a grid over the view, from the middle outwards, until one is selected.
  const box = (await page.locator("main.viewport canvas").boundingBox())!;
  const clicks: { x: number; y: number }[] = [];
  for (let y = box.y + 20; y < box.y + box.height - 60; y += 16) {
    for (let x = box.x + 20; x < box.x + box.width - 20; x += 16) clicks.push({ x, y });
  }
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  clicks.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
  for (const { x, y } of clicks) {
    await page.mouse.click(x, y);
    if ((await heading.textContent())?.startsWith("Product")) break;
  }
  await expect(heading).toHaveText(/^Product #\d+$/);
  const history = page.locator("aside.panel.right .product-history li");
  await expect(history.last()).toContainText("Entered the register");
  await expect(history.last()).toContainText(/\d+\.\d s ago/);
});

test("shows a product the PLC marked by its mark's name and colour, until marks are switched off", async ({ page }) => {
  await openApp(page);
  // Only the Delta line, framed from above, without the overlays above its belts.
  await page.getByRole("button", { name: "Show components" }).click();
  const others = ["Cartesian", "Cartesian X-Y", "Cartesian X-Z", "Cartesian infeed", "Cartesian outfeed"];
  others.push("IDH", "IDH infeed", "Tray belt", "Fxx", "Fxx infeed", "Fxx outfeed", "Spacing belt", "Spacer");
  for (const name of others) {
    const hide = page.getByRole("button", { name: `Hide ${name}`, exact: true });
    if (await hide.count()) await hide.click();
  }
  await page.getByRole("button", { name: "Hide components" }).click();
  for (const layer of ["Working areas", "Limit areas", "Zones", "TCP markers", "Fault labels"]) {
    await page.getByRole("button", { name: layer, exact: true }).click();
  }
  await page.getByRole("button", { name: "Show inspector" }).click();
  await page.getByRole("button", { name: "View from above" }).click();
  // Vision 1 of the demo marks every tenth product on Infeed 1 as a sample.
  await page.waitForTimeout(10_000);
  // Held still in the replay of the last moments, so a product stays where it was seen.
  await page.getByRole("button", { name: "Replay the last minute" }).click();
  const slider = page.getByRole("toolbar", { name: "Playback" }).getByLabel("Playback position");
  await slider.fill(String(Math.round(Number(await slider.getAttribute("max")) - 100)));
  await page.waitForTimeout(500);

  // A sample shows mark 1's magenta, the only colour of its hue in the scene: click where the view shows it.
  const canvas = page.locator("main.viewport canvas");
  const png = (await canvas.screenshot()).toString("base64");
  const candidates = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const context = new OffscreenCanvas(image.width, image.height).getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    // Magenta pixels by 8 px cell: the cells with the most first, each clicked at its pixels' centre.
    const cells = new Map<string, { x: number; y: number; n: number }>();
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4;
        const [r, g, b] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
        if (r < 140 || b < 150 || g > 100) continue;
        const key = `${Math.floor(x / 8)},${Math.floor(y / 8)}`;
        const cell = cells.get(key) ?? { x: 0, y: 0, n: 0 };
        cells.set(key, { x: cell.x + x, y: cell.y + y, n: cell.n + 1 });
      }
    }
    return [...cells.values()].sort((a, b) => b.n - a.n).map((c) => ({ x: c.x / c.n, y: c.y / c.n, n: c.n }));
  }, png);
  const box = (await canvas.boundingBox())!;
  const mark = page.locator("aside.panel.right .product-mark");
  for (const { x, y } of candidates.slice(0, 20)) {
    await page.mouse.click(box.x + x, box.y + y);
    if (await mark.isVisible()) break;
  }
  await expect(mark).toContainText("Sample");
  await expect(page.locator("aside.panel.right .product-history li", { hasText: "Marked as Sample" })).toHaveCount(1);
  const legendEntry = page.getByRole("dialog", { name: "Product colours" }).locator("li", { hasText: "mark: Sample" });
  await expect(legendEntry).toHaveClass("active");

  // Switched off, every product shows its state colour again.
  const toggle = page.getByRole("button", { name: "Product marks" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(legendEntry).not.toHaveClass("active");
});

test("shows the machine's metrics in the inspector while nothing is selected", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Show inspector" }).click();
  const inspector = page.locator("aside.panel.right");
  await expect(inspector.getByRole("heading", { name: /^Metrics, last \d+ s$/ })).toBeVisible({ timeout: 20_000 });
  await expect(inspector.locator("table.metrics")).toContainText("in/min");
  // Per client: what each robot, detector and station did.
  await expect(inspector.locator("table.metrics")).toContainText("picked/min", { timeout: 20_000 });
  await expect(inspector.locator("table.metrics")).toContainText("detected/min");
  await expect(inspector.locator("table.metrics tr", { hasText: "Reject unit" })).toContainText("rejected/min", {
    timeout: 30_000,
  });
});

test("loads in parts, none over 800 KB", async ({ request }) => {
  const html = await (await request.get("/")).text();
  const scripts = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  // The entry plus the chunks it preloads: the app is split, so a new version reloads only what changed.
  expect(scripts.length).toBeGreaterThan(1);
  for (const script of scripts) {
    const bytes = (await (await request.get(script)).body()).length;
    expect(bytes, script).toBeLessThan(800 * 1024);
  }
});

test("opens the PLC library guide from the status bar", async ({ page, context }) => {
  await openApp(page);
  const [docs] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: "PLC guide" }).click()]);
  await docs.waitForLoadState();
  expect(new URL(docs.url()).pathname).toBe("/docs");
  await expect(docs).toHaveTitle("Syn_Visu PLC library guide");
  await expect(docs.locator('[id="5-conveyors-and-products"]')).toBeVisible();
  await expect(docs.getByRole("img", { name: "The states of a product" })).toBeVisible();
  // Every link within the page leads to a heading on it.
  const broken = await docs.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('main a[href^="#"]')]
      .map((a) => a.getAttribute("href")!)
      .filter((href) => !document.getElementById(decodeURIComponent(href.slice(1)))),
  );
  expect(broken).toEqual([]);
});
