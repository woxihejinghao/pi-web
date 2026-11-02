#!/usr/bin/env python3
"""Run after pnpm build, with Python Playwright + Chromium installed.
Uses a disposable server, store, session log and stub pi; never user history.
"""
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

REPO = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="piws-move-ui-") as tmp:
    root = Path(tmp).resolve()
    workspace = root / "pi" / "workspace"
    workspace.mkdir(parents=True)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = {**os.environ, "HOME": str(root), "PI_WEB_SIMPLE_HOME": str(root / "store"),
           "PI_WEB_SIMPLE_SESSION_DIR": str(root / "sessions"),
           "PI_WEB_SIMPLE_PORT": str(port), "PI_WEB_SIMPLE_SKIP_TITLE_MIGRATION": "1"}
    (root / "sessions").mkdir()
    log = open(root / "server.log", "w+")
    process = subprocess.Popen(["pnpm", "exec", "tsx", "src/testing/move-ui-server.mts"],
                               cwd=REPO / "server", env=env, stdout=log, stderr=log,
                               start_new_session=True)

    def api(path, body=None, method=None):
        request = urllib.request.Request(base + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={"Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    try:
        for _ in range(300):
            try:
                api("/api/health")
                break
            except OSError:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                time.sleep(.1)
        else:
            log.seek(0)
            raise RuntimeError("fixture server did not start: " + log.read())
        projects = []
        for name in ["Source", "Destination"]:
            folder = workspace / name
            folder.mkdir()
            projects.append(api("/api/projects", {"path": str(folder)}))
        source, destination = projects
        session_dir = root / "sessions" / ("--" + source["path"].lstrip("/").replace("/", "-") + "--")
        session_dir.mkdir()
        old = session_dir / "move-ui.jsonl"
        old.write_text("\n".join(json.dumps(entry) for entry in [
            {"type": "session", "version": 3, "id": "move-ui", "cwd": source["path"], "timestamp": "2026-01-01T00:00:00Z"},
            {"type": "message", "id": "m1", "parentId": None, "timestamp": "2026-01-01T00:00:01Z",
             "message": {"role": "user", "content": "Browser move test"}}
        ]) + "\n")
        work_folder = workspace / "multirisk-review"
        (work_folder / ".nested").mkdir(parents=True)
        (work_folder / ".nested" / "review.txt").write_text("Associated report bytes")
        api("/api/settings", {"language": "en"}, "PUT")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            errors = []
            artifacts = os.environ.get("PI_WEB_UI_ARTIFACT_DIR")
            if artifacts:
                Path(artifacts).mkdir(parents=True, exist_ok=True)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(base)
            page.wait_for_load_state("networkidle")
            source_button = page.locator("[data-workspace-row]").get_by_role("button", name="Source", exact=True)
            if source_button.get_attribute("aria-expanded") != "true":
                source_button.click()
            row = page.locator(f'div[title="{old}"]')
            expect(row).to_be_visible()
            row.get_by_role("button", name="Browser move test", exact=True).click()
            # Persist an explicit association through the UI; selection itself never moves files.
            row.click(button="right")
            page.get_by_role("menuitem", name="Working folders", exact=True).click()
            working_dialog = page.get_by_role("dialog", name="Working folders", exact=True)
            expect(working_dialog.get_by_text("No working folders associated yet.", exact=True)).to_be_visible()
            working_dialog.get_by_role("button", name="Associate folder", exact=True).click()
            association_picker = page.get_by_role("dialog", name="Choose a project directory", exact=True)
            expect(association_picker.locator("footer span")).to_have_text(str(workspace))
            association_picker.get_by_role("textbox", name="Current path", exact=True).fill(str(work_folder))
            association_picker.get_by_role("textbox", name="Current path", exact=True).press("Enter")
            expect(association_picker.locator("footer span")).to_have_text(str(work_folder))
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_response(lambda response: response.url.endswith("/work-folders") and response.request.method == "PUT") as association_response:
                association_picker.get_by_role("button", name="Choose this directory", exact=True).click()
            assert association_response.value.ok, association_response.value.text()
            expect(working_dialog.get_by_text(str(work_folder), exact=True)).to_be_visible()
            if artifacts:
                page.screenshot(path=str(Path(artifacts) / "working-folders-en.png"))
            assert work_folder.exists(), "associating must not move files"
            working_dialog.get_by_role("button", name="Close", exact=True).click()
            row.click(button="right")
            page.get_by_role("menuitem", name="Move", exact=True).click()
            picker = page.get_by_role("dialog")
            expect(picker).to_be_visible()
            expect(picker.locator("footer span")).to_have_text(str(workspace))
            # Reopening always starts at the workspace root, not the last location or home.
            picker.get_by_role("button", name="Close", exact=True).click()
            row.hover()
            row.get_by_role("button", name="Move Browser move test", exact=True).click()
            expect(picker.locator("footer span")).to_have_text(str(workspace))
            # Inspect the rendered address field, then navigate with Enter.
            expect(picker.get_by_role("button", name="Home", exact=True)).to_be_visible()
            expect(picker.get_by_role("button", name="Root", exact=True)).to_be_visible()
            expect(picker.get_by_role("button", name="Close", exact=True)).to_be_visible()
            artifacts = os.environ.get("PI_WEB_UI_ARTIFACT_DIR")
            if artifacts:
                Path(artifacts).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(artifacts) / "move-picker-en.png"))
            address = picker.locator("input").first
            expect(picker.locator("footer span")).not_to_have_text("—")
            expect(picker.get_by_role("button", name="Go", exact=True)).to_be_enabled()
            address.fill(destination["path"])
            with page.expect_response(lambda response: "/api/fs/list?path=" in response.url) as listing_response:
                address.press("Enter")
            assert listing_response.value.ok, listing_response.value.text()
            expect(picker.locator("footer span")).to_have_text(destination["path"])
            choose = picker.get_by_role("button", name="Choose this directory", exact=True)
            expect(choose).to_be_enabled()
            dialogs = []
            def dismiss(dialog):
                dialogs.append(dialog.message)
                dialog.dismiss()
            page.on("dialog", dismiss)
            with page.expect_event("dialog"):
                choose.click()
            assert len(dialogs) == 1 and str(work_folder) in dialogs[0]
            assert str(Path(destination["path"]) / work_folder.name) in dialogs[0]
            assert old.exists(), "cancel must preserve the source"
            assert (work_folder / ".nested" / "review.txt").read_text() == "Associated report bytes"
            expect(picker).to_be_visible()
            page.remove_listener("dialog", dismiss)
            page.once("dialog", lambda dialog: dialog.accept())
            choose.click()
            expect(picker).not_to_be_visible()
            assert not old.exists()
            moved_folder = Path(destination["path"]) / work_folder.name
            assert not work_folder.exists()
            assert (moved_folder / ".nested" / "review.txt").read_text() == "Associated report bytes"
            moved = api(f'/api/projects/{destination["id"]}/sessions')["sessions"]
            assert len(moved) == 1 and moved[0]["cwd"] == destination["path"]
            expect(page.locator(f'div[title="{moved[0]["path"]}"]')).to_have_class(re.compile("sessionRowActive"))
            assert api(f'/api/projects/{source["id"]}/sessions')["sessions"] == []
            # Native mouse drag onto an empty, collapsed workspace; first cancel, then accept.
            if source_button.get_attribute("aria-expanded") == "true":
                source_button.click()
            target_row = page.locator(f'[data-workspace-row][title="{source["path"]}"]')
            moved_row = page.locator(f'div[title="{moved[0]["path"]}"]')
            cancelled_drops = []
            def cancel_drop(dialog):
                cancelled_drops.append(dialog.message)
                dialog.dismiss()
            page.on("dialog", cancel_drop)
            origin = moved_row.bounding_box()
            target_bounds = target_row.bounding_box()
            assert origin and target_bounds
            page.mouse.move(origin["x"] + 60, origin["y"] + origin["height"] / 2)
            page.mouse.down()
            page.mouse.move(origin["x"] + 75, origin["y"] + origin["height"] / 2, steps=5)
            page.mouse.move(target_bounds["x"] + 80, target_bounds["y"] + target_bounds["height"] / 2, steps=10)
            page.mouse.move(target_bounds["x"] + 81, target_bounds["y"] + target_bounds["height"] / 2)
            expect(target_row).to_have_attribute("data-session-drop-target", "true")
            if artifacts:
                page.screenshot(path=str(Path(artifacts) / "drag-workspace-target-en.png"))
            with page.expect_event("dialog"):
                page.mouse.up()
            assert len(cancelled_drops) == 1
            assert Path(moved[0]["path"]).exists()
            assert (moved_folder / ".nested" / "review.txt").read_text() == "Associated report bytes"
            page.remove_listener("dialog", cancel_drop)
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_response(lambda response: response.url.endswith("/move") and response.request.method == "POST") as drag_response:
                moved_row.drag_to(target_row)
            assert drag_response.value.ok, drag_response.value.text()
            returned = api(f'/api/projects/{source["id"]}/sessions')["sessions"]
            assert len(returned) == 1 and returned[0]["cwd"] == source["path"]
            assert (Path(source["path"]) / work_folder.name / ".nested" / "review.txt").read_text() == "Associated report bytes"
            assert not moved_folder.exists()
            expect(page.locator(f'div[title="{returned[0]["path"]}"]')).to_be_visible()
            page.once("dialog", lambda dialog: dialog.accept())
            with page.expect_response(lambda response: response.url.endswith("/move") and response.request.method == "POST") as drag_response:
                page.locator(f'div[title="{returned[0]["path"]}"]').drag_to(
                    page.locator(f'[data-workspace-row][title="{destination["path"]}"]'))
            assert drag_response.value.ok, drag_response.value.text()
            assert api(f'/api/projects/{source["id"]}/sessions')["sessions"] == []
            assert (moved_folder / ".nested" / "review.txt").read_text() == "Associated report bytes"
            page.reload()
            page.wait_for_load_state("networkidle")
            target_button = page.locator("[data-workspace-row]").get_by_role("button", name="Destination", exact=True)
            if target_button.get_attribute("aria-expanded") != "true":
                target_button.click()
            expect(page.get_by_role("button", name="Browser move test", exact=True)).to_be_visible()
            page.get_by_role("button", name="Browser move test", exact=True).click(button="right")
            page.get_by_role("menuitem", name="Working folders", exact=True).click()
            expect(working_dialog.get_by_text(str(moved_folder), exact=True)).to_be_visible()
            page.set_viewport_size({"width": 390, "height": 844})
            bounds = working_dialog.bounding_box()
            assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 390
            if artifacts:
                page.screenshot(path=str(Path(artifacts) / "working-folders-mobile-en.png"))
            working_dialog.get_by_role("button", name="Close", exact=True).click()
            page.set_viewport_size({"width": 1280, "height": 720})
            # A missing preferred root is reported in English; never silently switch to home.
            hidden_workspace = root / "temporarily-hidden-workspace"
            workspace.rename(hidden_workspace)
            try:
                page.get_by_role("button", name="Browser move test", exact=True).hover()
                page.get_by_role("button", name="Move Browser move test", exact=True).click()
                expect(picker.get_by_text("Directory does not exist: ~/pi/workspace", exact=True)).to_be_visible()
                expect(picker.get_by_role("button", name="Choose this directory", exact=True)).to_be_disabled()
                picker.get_by_role("button", name="Close", exact=True).click()
            finally:
                hidden_workspace.rename(workspace)
            # Other uses of the picker keep their original default.
            page.get_by_role("button", name="Add workspace", exact=True).click()
            expect(picker.locator("footer span")).to_have_text(str(root))
            picker.get_by_role("button", name="Close", exact=True).click()
            page.get_by_role("button", name="Settings", exact=True).click()
            prompt = page.get_by_role("textbox", name="System Prompt", exact=True)
            expect(prompt).to_be_visible()
            prompt.fill("Browser-tested persistent instructions.")
            with page.expect_response(lambda response: response.url.endswith("/api/settings") and response.request.method == "PUT"):
                prompt.press("Tab")
            assert api("/api/settings")["systemPrompt"] == "Browser-tested persistent instructions."
            if artifacts:
                page.screenshot(path=str(Path(artifacts) / "system-prompt-en.png"))
            page.reload()
            page.wait_for_load_state("networkidle")
            if not prompt.is_visible():
                page.get_by_role("button", name="Settings", exact=True).click()
            expect(prompt).to_have_value("Browser-tested persistent instructions.")
            page.set_viewport_size({"width": 390, "height": 844})
            expect(prompt).to_be_visible()
            bounds = prompt.bounding_box()
            assert bounds and bounds["x"] >= 0 and bounds["x"] + bounds["width"] <= 390
            if artifacts:
                page.screenshot(path=str(Path(artifacts) / "system-prompt-mobile-en.png"))
            assert not errors, errors
            browser.close()
        print("PASS: explicit working-folder association, chat+files via picker/native drag, cancel/confirm, collapsed empty destination, nested report bytes and associations after reload, mobile dialog, preferred-root handling and persistent system prompt; no model calls")
    finally:
        import signal
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
        log.close()
