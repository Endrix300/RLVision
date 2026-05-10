#!/usr/bin/env python3
"""
RL Swap Daemon - Runs independently and watches a config file for swap commands
This completely isolates Python from Node.js/Electron to avoid file handle issues
"""
import json
import time
import sys
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Add parent directory to path for imports
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from main import load_items, SwapOptions, swap_asset

COOKED = Path(r"C:\Program Files\Epic Games\rocketleague\TAGame\CookedPCConsole")
CONFIG_FILE = HERE / "swap_commands.json"
RESPONSE_FILE = HERE / "swap_responses.json"

def make_opts(cooked_dir: Path = COOKED):
    return SwapOptions(
        items_path=HERE / "items.json",
        keys_path=HERE / "keys.txt",
        donor_dir=cooked_dir,
        output_dir=cooked_dir,
        key_source_dir=cooked_dir,
        include_thumbnails=False,
        preserve_header_offsets=True,
        overwrite=True,
    )

def process_command(cmd):
    """Process a single swap command"""
    try:
        import rl_asset_swapper
        upk = rl_asset_swapper.import_rl_upk_editor()
    except Exception as e:
        return {"success": False, "error": f"Failed to import rl_upk_editor: {e}"}

    cooked_dir = Path(cmd.get("cooked_dir", COOKED))
    opts = make_opts(cooked_dir)
    items = load_items(HERE / "items.json")

    from main import search_items, pick_one

    source = pick_one(search_items(items, cmd["source"]), cmd["source"])
    target = pick_one(search_items(items, cmd["target"]), cmd["target"])

    if source is None or target is None:
        return {"success": False, "error": "Item not found"}

    try:
        paths, log_lines = swap_asset(upk, target, source, opts)
        ok = bool(paths)
        return {
            "success": ok,
            "logs": log_lines,
            "message": "OK - swap applied." if ok else "ERROR - swap failed."
        }
    except Exception as e:
        import traceback
        return {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }

class ConfigFileHandler(FileSystemEventHandler):
    """Watches for changes to the config file"""
    def on_modified(self, event):
        if event.src_path != str(CONFIG_FILE):
            return

        try:
            # Read commands
            commands = json.loads(CONFIG_FILE.read_text())

            # Process pending commands
            responses = {}
            for cmd_id, cmd in commands.items():
                if cmd.get("status") == "pending":
                    print(f"[Daemon] Processing command {cmd_id}: {cmd}")
                    result = process_command(cmd)
                    responses[cmd_id] = {
                        **result,
                        "status": "completed",
                        "timestamp": time.time()
                    }

            # Write responses
            if responses:
                RESPONSE_FILE.write_text(json.dumps(responses, indent=2))

        except Exception as e:
            print(f"[Daemon] Error: {e}")

def main():
    print("[Daemon] RL Swap Daemon starting...")
    print(f"[Daemon] Watching: {CONFIG_FILE}")

    # Initialize config file if it doesn't exist
    if not CONFIG_FILE.exists():
        CONFIG_FILE.write_text("{}")

    # Start file watcher
    observer = Observer()
    observer.schedule(ConfigFileHandler(), path=str(HERE), recursive=False)
    observer.start()

    print("[Daemon] Daemon running. Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    main()
