import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/** Every uncaught error in the page fails the test that saw it. */
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

/** Infeed 1's products in the demo's newest state, read from the gateway's WebSocket like any client. */
async function infeed1Products(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
        const timer = setTimeout(() => (socket.close(), reject(new Error("no state"))), 5000);
        socket.onmessage = (e) => {
          const message = JSON.parse(String(e.data));
          const infeed = message.kind === "state" ? message.components.find((c: { id: number }) => c.id === 1) : undefined;
          if (!infeed) return;
          clearTimeout(timer);
          socket.close();
          resolve(infeed.products.length);
        };
      }),
  );
}

const runState = (page: Page) => page.getByLabel("Run state");
const recipe = (page: Page) => page.locator("aside.panel.right .recipe");

/**
 * Opens the Simulator with the demo running on its program values, as every other browser test expects it: a test
 * that stops the machine or writes a recipe puts it back at its end, and at its start in case an earlier run stopped
 * halfway.
 */
async function openAtProgramValues(page: Page): Promise<void> {
  await page.goto("/simulator/");
  await expect(recipe(page)).toContainText(/Recipe v\d+ active in the PLC|The PLC runs its program values/);
  const discard = recipe(page).getByRole("button", { name: "Discard" });
  if (await discard.isEnabled()) await discard.click();
  const programValues = recipe(page).getByRole("button", { name: "Program values" });
  if (await programValues.isEnabled()) {
    page.once("dialog", (dialog) => void dialog.accept());
    await programValues.click();
    await expect(recipe(page)).toContainText("The PLC runs its program values");
  }
  await expect(runState(page)).toHaveText(/^(Starting|Running|Stopping|Stopped)/);
  if ((await runState(page).textContent())?.startsWith("Stopping")) await expect(runState(page)).toHaveText(/^Stopped/);
  const start = page.getByRole("button", { name: "Start", exact: true });
  if (await start.isEnabled()) await start.click();
  await expect(runState(page)).toHaveText(/^Running/, { timeout: 10_000 });
}

test("shows the demo's recipe grouped by component, its run state and the commands it takes now", async ({ page }) => {
  await openAtProgramValues(page);
  const legends = await recipe(page).locator("fieldset legend").allTextContents();
  expect(legends).toEqual(["Infeed 1", "Delta 1", "Machine"]);
  await expect(recipe(page).locator("fieldset", { hasText: "Infeed 1" })).toContainText("Belt speed [mm/s]");
  await expect(recipe(page).locator("fieldset", { hasText: "Delta 1" })).toContainText("Picks per cycle");
  await expect(recipe(page).getByLabel("Belt speed", { exact: true })).toHaveValue("150");
  await expect(recipe(page).getByLabel("Type mix")).toHaveValue("0");
  await expect(recipe(page).getByLabel("Feed")).toBeChecked();
  // Running: it can be stopped, not started or reset.
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeDisabled();
});

test("writes a new belt speed and feed rate, which the demo applies, and returns to its program values", async ({ page }) => {
  await openAtProgramValues(page);
  const belt = recipe(page).getByLabel("Belt speed", { exact: true });
  await belt.fill("200");
  await belt.press("Enter");
  const rate = recipe(page).getByLabel("Rate", { exact: true });
  await rate.fill("90");
  await rate.press("Enter");
  await expect(recipe(page)).toContainText("Active: 150 mm/s");

  await recipe(page).getByRole("button", { name: "Write 2 changes" }).click();
  await expect(recipe(page)).toContainText("Recipe applied.");
  await expect(recipe(page)).toContainText(/Recipe v\d+ active in the PLC/);
  await expect(belt).toHaveValue("200");
  await expect(rate).toHaveValue("90");
  await expect(recipe(page)).not.toContainText("Active:");

  page.once("dialog", (dialog) => void dialog.accept());
  await recipe(page).getByRole("button", { name: "Program values" }).click();
  await expect(recipe(page)).toContainText("The PLC runs its program values");
  await expect(belt).toHaveValue("150");
});

test("stops and resets the demo, which clears its products, and starts it again: products come, Delta 1 picks", async ({ page }) => {
  await openAtProgramValues(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".toolbar")).toContainText("Stop accepted");
  await expect(runState(page)).toHaveText(/^Stopped/, { timeout: 10_000 });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator(".toolbar")).toContainText("Reset accepted");
  await expect.poll(() => infeed1Products(page)).toBe(0);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(runState(page)).toHaveText(/^Running/, { timeout: 10_000 });
  await expect.poll(() => infeed1Products(page), { timeout: 15_000 }).toBeGreaterThan(0);
  // The metrics below the recipe count what Delta 1 picks.
  const metrics = page.locator("aside.panel.right table.metrics");
  await expect(metrics.locator("tr", { hasText: "Delta 1" })).toContainText(/([1-9]\d*\.\d|0\.[1-9]) picked\/min/, {
    timeout: 30_000,
  });
});

test("lists a machine message the demo raises, and selects its component", async ({ page }) => {
  await openAtProgramValues(page);
  // The demo warns about the reject bin for 4 s at the start of every 20 s.
  await page.locator("footer").getByRole("button", { name: /messages?$/ }).click();
  const entry = page
    .locator("ul.status-messages")
    .getByRole("button", { name: /^Reject unit: Reject bin almost full · #1 · / });
  await expect(entry).toBeVisible({ timeout: 25_000 });
  await entry.click();
  await expect(page.locator("aside.panel.left .tree button.selected")).toContainText("Reject unit");

  // A component with recipe fields brings its group into view, marked.
  await page.locator("aside.panel.left .tree").getByRole("button", { name: /Delta 1 #10/ }).click();
  await expect(recipe(page).locator("fieldset.selected legend")).toHaveText("Delta 1");
});

test("saves the recipe to a file and opens it again", async ({ page }) => {
  await openAtProgramValues(page);
  await recipe(page).getByLabel("Recipe name").fill("E2E feed");
  await recipe(page).getByLabel("Recipe name").press("Enter");
  const rate = recipe(page).getByLabel("Rate", { exact: true });
  await rate.fill("75");
  await rate.press("Enter");

  const [download] = await Promise.all([page.waitForEvent("download"), recipe(page).getByRole("button", { name: "Save" }).click()]);
  expect(download.suggestedFilename()).toBe("E2E feed.rpp-sim.json");
  const path = await download.path();
  const saved = JSON.parse(await readFile(path, "utf8"));
  expect(saved.format).toBe("rpp-sim");
  expect(saved.sources[0].values["0"].Rate).toBe(75);

  // Changed again and not saved: opening the file asks first.
  await rate.fill("80");
  await rate.press("Enter");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("Open a recipe file").setInputFiles(path);
  await expect(rate).toHaveValue("75");
  await expect(recipe(page).getByLabel("Recipe name")).toHaveValue("E2E feed");
  await expect(recipe(page).getByRole("button", { name: "Write 1 change" })).toBeEnabled();

  await recipe(page).getByRole("button", { name: "Discard" }).click();
  await expect(rate).toHaveValue("60");
});

test("loads in parts below its own path, none over 800 KB", async ({ request }) => {
  const html = await (await request.get("/simulator/")).text();
  const scripts = [...html.matchAll(/(?:src|href)="(\/simulator\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(1);
  for (const script of scripts) {
    const bytes = (await (await request.get(script)).body()).length;
    expect(bytes, script).toBeLessThan(800 * 1024);
  }
});

test("closes and resizes its side panels, and keeps them across a reload", async ({ page }) => {
  await page.goto("/simulator/");
  const left = page.locator("aside.panel.left");
  const right = page.locator("aside.panel.right");
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();

  await page.getByRole("button", { name: "Hide components" }).click();
  await expect(left).toBeHidden();
  const before = (await right.boundingBox())!.width;
  const edge = (await page.getByLabel("Resize recipe").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 100, edge.y + 200, { steps: 5 });
  await page.mouse.up();
  const widened = (await right.boundingBox())!.width;
  expect(widened).toBeGreaterThan(before + 50);

  await page.reload();
  await expect(left).toBeHidden();
  expect(Math.abs((await right.boundingBox())!.width - widened)).toBeLessThan(2);
  await page.getByRole("button", { name: "Show components" }).click();
  await expect(left).toBeVisible();
});
