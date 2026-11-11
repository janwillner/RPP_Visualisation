import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

/** The draft's problems, listed above the status bar once its count is clicked. */
async function problems(page: Page) {
  const list = page.locator("ul.problems");
  if (!(await list.isVisible())) await page.locator("footer").getByRole("button", { name: /problems?$/ }).click();
  return list;
}

/** Every uncaught error in the page fails the test that saw it. */
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("configurator: places components, edits a value, undoes it, saves the draft and opens it again", async ({ page }) => {
  await page.goto("/configurator");
  await expect(page.locator(".toolbar .title")).toHaveText("RPP Configurator");
  await expect(page.locator("main.viewport canvas")).toBeVisible();

  const palette = page.locator(".palette");
  await palette.getByRole("button", { name: "Conveyor" }).click();
  await palette.getByRole("button", { name: "Delta" }).click();
  const list = page.locator("aside.panel.left .components");
  await expect(list).toContainText("Conveyor 1");
  await expect(list).toContainText("Delta 2");

  // The new Delta is selected; select the conveyor and lengthen it.
  await list.getByRole("button", { name: /Conveyor 1/ }).click();
  const properties = page.locator("aside.panel.right");
  await expect(properties.locator("h3")).toHaveText("Conveyor 1");
  const length = properties.getByLabel("Length", { exact: true });
  await expect(length).toHaveValue("2000");
  await length.fill("3500");
  await length.press("Enter");
  await expect(length).toHaveValue("3500");

  // Escape drops what was typed.
  await length.fill("9999");
  await length.press("Escape");
  await expect(length).toHaveValue("3500");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(length).toHaveValue("2000");
  await page.getByRole("button", { name: "Redo" }).click();
  await expect(length).toHaveValue("3500");
  await expect(page.locator(".statusbar")).toContainText("not saved");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save" }).click()]);
  expect(download.suggestedFilename()).toBe("Machine.rpp-draft.json");
  const file = await download.path();
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    format: "rpp-draft",
    components: [{ type: "conveyor", length: 3500 }, { type: "delta" }],
  });
  await expect(page.locator(".statusbar")).not.toContainText("not saved");

  await page.getByRole("button", { name: "New" }).click();
  await expect(list).not.toContainText("Conveyor 1");
  await page.getByLabel("Open a draft file").setInputFiles(file);
  await expect(list).toContainText("Conveyor 1");
  await list.getByRole("button", { name: /Conveyor 1/ }).click();
  await expect(properties.getByLabel("Length", { exact: true })).toHaveValue("3500");
});

test("configurator: gives a Delta a zone on the conveyor and the conveyor a product type, and warns of a zone past the belt", async ({ page }) => {
  await page.goto("/configurator");
  const palette = page.locator(".palette");
  await palette.getByRole("button", { name: "Conveyor" }).click();
  await palette.getByRole("button", { name: "Delta" }).click();
  const properties = page.locator("aside.panel.right");
  await expect(properties.locator("h3")).toHaveText("Delta 2");

  await properties.getByRole("button", { name: "Add zone" }).click();
  const zone = properties.getByRole("group", { name: "Zone 1" });
  await expect(zone.getByLabel("Start", { exact: true })).toHaveValue("750");
  await expect(zone.getByLabel("Conveyor", { exact: true })).toHaveValue("1");
  const end = zone.getByLabel("End", { exact: true });
  await end.fill("2100");
  await end.press("Enter");
  await expect(await problems(page)).toContainText("reaches past the belt");

  await page.locator("aside.panel.left .components").getByRole("button", { name: /Conveyor 1/ }).click();
  await properties.getByRole("button", { name: "Add product type" }).click();
  const type = properties.getByRole("group", { name: "Product type 1" });
  await expect(type.getByLabel("Length", { exact: true })).toHaveValue("120");
  await type.getByLabel("Shape", { exact: true }).selectOption("cylinder");
  await expect(type.getByLabel("Shape", { exact: true })).toHaveValue("cylinder");

  await type.getByRole("button", { name: /Remove/ }).click();
  await expect(properties.getByRole("group", { name: "Product type 1" })).toHaveCount(0);
});

test("configurator: imports the simulator's configuration, reconciles it and marks a changed component", async ({ page }) => {
  await page.goto("/configurator");
  const plcs = page.locator("aside.panel.left .plcs");
  await expect(plcs).toContainText("Simulator");
  await plcs.getByRole("button", { name: "Import" }).first().click();

  const list = page.locator("aside.panel.left .components");
  const delta = list.getByRole("button", { name: /Delta 1/ });
  await expect(delta).toContainText("PLC");
  await expect(list.getByRole("button", { name: /Infeed/ })).toContainText("PLC");

  await delta.click();
  const x = page.locator("aside.panel.right fieldset").filter({ hasText: "Pose" }).first().getByLabel("X", { exact: true });
  await x.fill(String(Number(await x.inputValue()) + 100));
  await x.press("Enter");
  await expect(delta).toContainText("changed");
  await expect(page.locator(".statusbar")).toContainText("Gateway: open");
});

test("configurator: writes a changed zone to the simulator, which takes it over and shows it", async ({ page }) => {
  await page.goto("/configurator");
  await page.locator("aside.panel.left .plcs").getByRole("button", { name: "Import" }).first().click();
  const list = page.locator("aside.panel.left .components");
  const delta = list.getByRole("button", { name: /Delta 1/ });
  await delta.click();

  const zone = page.locator("aside.panel.right").getByRole("group", { name: "Zone 1" });
  const end = zone.getByLabel("End", { exact: true });
  const before = Number(await end.inputValue());
  await end.fill(String(before + 100));
  await end.press("Enter");
  await expect(delta).toContainText("changed");

  await page.locator("aside.panel.left .plcs").getByRole("button", { name: "Write…" }).first().click();
  const dialog = page.getByRole("dialog", { name: /Write to/ });
  await expect(dialog).toContainText("Delta 1");
  await expect(dialog).toContainText("zones.1.end");
  await expect(dialog).toContainText(String(before + 100));
  await dialog.getByRole("button", { name: "Write", exact: true }).click();

  await expect(delta).toContainText("written");
  // The simulated application passed the new set on to Syn_Visu: the PLC now has what the draft has.
  await expect(delta).toContainText("PLC");
  await expect(delta).not.toContainText("changed");
});

test("configurator: edits an XTS loop's modules, a station's bodies and a Cartesian robot's limit area", async ({ page }) => {
  await page.goto("/configurator");
  const palette = page.locator(".palette");
  const properties = page.locator("aside.panel.right");

  await palette.getByRole("button", { name: "XTS loop" }).click();
  await expect(properties.locator("h3")).toHaveText("XTS loop 1");
  await expect(properties.getByRole("group", { name: "Module 12" })).toBeVisible();
  await properties.getByLabel("Kind of the new module").selectOption("curveRight");
  await properties.getByRole("button", { name: "Add module" }).click();
  await expect(properties.getByRole("group", { name: "Module 13" }).getByLabel("Kind", { exact: true })).toHaveValue("curveRight");
  await expect(await problems(page)).toContainText("does not end where it starts");
  await properties.getByRole("group", { name: "Module 13" }).getByRole("button", { name: /Remove/ }).click();
  await expect(page.getByText("does not end where it starts")).toHaveCount(0);

  await palette.getByRole("button", { name: "Station" }).click();
  await properties.getByRole("button", { name: "Add body" }).click();
  const body = properties.getByRole("group", { name: "Body 3" });
  await expect(body.getByLabel("Height", { exact: true })).toHaveValue("100");

  await palette.getByRole("button", { name: "Cartesian" }).click();
  await properties.getByRole("button", { name: "Add limit area" }).click();
  const area = properties.getByRole("group", { name: "Limit area" });
  await expect(area.getByLabel("X max", { exact: true })).toHaveValue("1200");
  await area.getByRole("button", { name: /Remove/ }).click();
  await expect(properties.getByRole("button", { name: "Add limit area" })).toBeVisible();
});

test("configurator: writes an XTS gantry's track to the simulator", async ({ page }) => {
  await page.goto("/configurator");
  await page.locator("aside.panel.left .plcs").getByRole("button", { name: "Import" }).first().click();
  const idh = page.locator("aside.panel.left .components").getByRole("button", { name: /^IDH #30/ });
  await idh.click();

  const properties = page.locator("aside.panel.right");
  await properties.getByRole("button", { name: "Add module" }).click();
  await expect(idh).toContainText("changed");

  await page.locator("aside.panel.left .plcs").getByRole("button", { name: "Write…" }).first().click();
  const dialog = page.getByRole("dialog", { name: /Write to/ });
  await expect(dialog).toContainText("IDH");
  await expect(dialog).toContainText("modules.7");
  await dialog.getByRole("button", { name: "Write", exact: true }).click();

  await expect(idh).toContainText("written");
  await expect(idh).toContainText("PLC");
  await expect(idh).not.toContainText("changed");
});

test("configurator: lays out a Delta's gripper fingers in the top view of its flange", async ({ page }) => {
  await page.goto("/configurator");
  await page.locator(".palette").getByRole("button", { name: "Delta" }).click();
  const properties = page.locator("aside.panel.right");
  await properties.getByRole("button", { name: "Add finger" }).click();
  await properties.getByRole("button", { name: "Add finger" }).click();
  const second = properties.getByRole("group", { name: "Finger 2" });
  const offsetX = second.getByLabel("Offset X", { exact: true });
  await expect(offsetX).toHaveValue("60");

  // Dragged to the right in the top view: further along the flange's X, on the 5 mm grid.
  const finger = properties.getByRole("button", { name: /^Finger 2 at/ });
  await finger.scrollIntoViewIfNeeded();
  const box = (await finger.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const moved = Number(await offsetX.inputValue());
  expect(moved).toBeGreaterThan(60);
  expect(moved % 5).toBe(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(offsetX).toHaveValue("60");
});

test("configurator: loads in parts below its own path, none over 800 KB", async ({ request }) => {
  const html = await (await request.get("/configurator")).text();
  const scripts = [...html.matchAll(/(?:src|href)="(\/configurator\/assets\/[^"]+\.js)"/g)].map((m) => m[1]!);
  // The entry plus the chunks it preloads: the app is split, so a new version reloads only what changed.
  expect(scripts.length).toBeGreaterThan(1);
  for (const script of scripts) {
    const bytes = (await (await request.get(script)).body()).length;
    expect(bytes, script).toBeLessThan(800 * 1024);
  }
});

test("configurator: closes and resizes its side panels, and keeps them across a reload", async ({ page }) => {
  await page.goto("/configurator");
  const left = page.locator("aside.panel.left");
  const right = page.locator("aside.panel.right");
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();

  await page.getByRole("button", { name: "Hide palette and components" }).click();
  await expect(left).toBeHidden();
  const before = (await right.boundingBox())!.width;
  const edge = (await page.getByLabel("Resize properties").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 100, edge.y + 200, { steps: 5 });
  await page.mouse.up();
  const widened = (await right.boundingBox())!.width;
  expect(widened).toBeGreaterThan(before + 50);

  await page.reload();
  await expect(left).toBeHidden();
  expect(Math.abs((await right.boundingBox())!.width - widened)).toBeLessThan(2);
  await page.getByRole("button", { name: "Show palette and components" }).click();
  await expect(left).toBeVisible();
});
