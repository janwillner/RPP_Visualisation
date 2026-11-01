import { expect, test, type Page } from "@playwright/test";

/** Opens the app on the simulator and waits until its components are discovered. */
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

test("shows the simulated machine: 3D view and component tree", async ({ page }) => {
  await openApp(page);
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
  const edge = (await page.getByLabel("Resize the components panel").boundingBox())!;
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
  // The simulator puts a mover in a fault every 20 s; one active when recording starts is marked at the start.
  await expect(page.locator("aside.panel.left .fault-icon").first()).toBeVisible({ timeout: 25_000 });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Stop recording" }).click();

  const bar = page.getByRole("toolbar", { name: "Playback" });
  const marker = bar.locator(".timeline-marker.fault").last();
  await expect(marker).toHaveAttribute("title", /Fault · /);
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
