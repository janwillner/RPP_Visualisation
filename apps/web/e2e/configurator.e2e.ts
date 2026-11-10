import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

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
  const list = page.locator("aside.panel.left .tree");
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
  await expect(page.locator(".issues")).toContainText("reaches past the belt");

  await page.locator("aside.panel.left .tree").getByRole("button", { name: /Conveyor 1/ }).click();
  await properties.getByRole("button", { name: "Add product type" }).click();
  const type = properties.getByRole("group", { name: "Product type 1" });
  await expect(type.getByLabel("Length", { exact: true })).toHaveValue("120");
  await type.getByLabel("Shape", { exact: true }).selectOption("cylinder");
  await expect(type.getByLabel("Shape", { exact: true })).toHaveValue("cylinder");

  await type.getByRole("button", { name: /Remove/ }).click();
  await expect(properties.getByRole("group", { name: "Product type 1" })).toHaveCount(0);
});
