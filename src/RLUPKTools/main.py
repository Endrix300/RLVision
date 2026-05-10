#!/usr/bin/env python3
"""
RL Swap CLI
Usage:
    python main.py swap         --source "Interstellar" --target "Biomass"
    python main.py revert       --target "Biomass"
    python main.py revert-all
    python main.py list
    python main.py search       "Octane"
    python main.py browse       --slot Decal
    python main.py slots
"""
import argparse
import json
import shutil
import sys
import datetime
from pathlib import Path

COOKED = Path(r"C:\Program Files\Epic Games\rocketleague\TAGame\CookedPCConsole")
HERE   = Path(__file__).parent
LOG    = HERE / "swap_journal.jsonl"

sys.path.insert(0, str(HERE))
from rl_asset_swapper import load_items, SwapOptions, swap_asset, revert_item


def make_opts(cooked_dir: Path = COOKED):
    return SwapOptions(
        items_path=HERE / "items.json",
        keys_path=HERE / "keys.txt",
        donor_dir=cooked_dir,
        output_dir=cooked_dir,
        key_source_dir=cooked_dir,
        include_thumbnails=False,   # thumbnails causent des crashes
        preserve_header_offsets=True,
        overwrite=True,
    )


def log_entry(entry: dict):
    with LOG.open("a", encoding="utf-8") as f:
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
        f.write(json.dumps({**entry, "ts": ts}) + "\n")


def read_log() -> list:
    if not LOG.exists():
        return []
    return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines() if l.strip()]


def active_swaps() -> dict:
    active = {}
    for e in read_log():
        if e["op"] == "swap" and e.get("ok"):
            active[e["target"]] = e
        elif e["op"] in ("revert", "revert-all"):
            if "target" in e:
                active.pop(e["target"], None)
            else:
                active.clear()
    return active


def search_items(items: list, query: str) -> list:
    q = query.lower()
    return [
        i for i in items
        if q == str(i.id)
        or q in (i.product or "").lower()
        or q in (i.asset_package or "").lower()
    ]


def pick_one(results, query):
    if not results:
        print(f"Introuvable: '{query}'")
        return None
    if len(results) == 1:
        return results[0]
    print(f"Plusieurs resultats pour '{query}' — utilise l'ID:")
    for i in results[:20]:
        print(f"  [{i.id}] {i.product} / {i.slot} ({i.asset_package})")
    return None


def fmt_item(i):
    return f"[{i.id}] {i.product} / {i.slot} ({i.asset_package})"


# ── commandes ────────────────────────────────────────────────────────────────

def cmd_swap(args, items):
    source = pick_one(search_items(items, args.source), args.source)
    target = pick_one(search_items(items, args.target), args.target)
    if source is None or target is None:
        return 1

    upk = HERE  # module rl_upk_editor via import_rl_upk_editor()
    import rl_asset_swapper
    upk = rl_asset_swapper.import_rl_upk_editor()

    cooked_dir = Path(args.cooked_dir) if getattr(args, "cooked_dir", None) else COOKED
    opts = make_opts(cooked_dir)
    print(f"Swap: {source.product} -> {target.product}")
    paths, log_lines = swap_asset(upk, target, source, opts)
    for line in log_lines:
        print(" ", line)

    ok = bool(paths)
    log_entry({"op": "swap", "source": source.product, "source_id": source.id,
               "target": target.product, "target_id": target.id,
               "target_pkg": target.asset_package, "ok": ok})
    print("OK - swap applique." if ok else "ERREUR - swap echoue.")
    return 0 if ok else 1


def cmd_revert(args, items):
    target = pick_one(search_items(items, args.target), args.target)
    if target is None:
        return 1
    cooked_dir = Path(args.cooked_dir) if getattr(args, "cooked_dir", None) else COOKED
    return _do_revert(target, cooked_dir)


def _do_revert(target, cooked_dir: Path = COOKED) -> int:
    bak = cooked_dir / f"{target.asset_package}.bak"
    dst = cooked_dir / target.asset_package
    if bak.exists():
        shutil.copy2(bak, dst)
        print(f"Revert OK: {target.asset_package} restaure depuis .bak")
        log_entry({"op": "revert", "target": target.product,
                   "target_pkg": target.asset_package, "ok": True})
        return 0

    import rl_asset_swapper
    upk = rl_asset_swapper.import_rl_upk_editor()
    opts = make_opts(cooked_dir)
    paths, log_lines = revert_item(target, opts)
    for line in log_lines:
        print(" ", line)
    ok = bool(paths)
    log_entry({"op": "revert", "target": target.product,
               "target_pkg": target.asset_package, "ok": ok})
    print("Revert OK." if ok else "ERREUR revert.")
    return 0 if ok else 1


def cmd_revert_all(args, items):
    active = active_swaps()
    if not active:
        print("Aucun swap actif.")
        return 0

    print(f"Revert de {len(active)} swap(s)...")
    errors = 0
    items_by_product = {i.product: i for i in items}

    for name, entry in list(active.items()):
        # Chercher l'item par package si possible
        pkg = entry.get("target_pkg", "")
        matches = [i for i in items if i.asset_package == pkg] if pkg else []
        if not matches:
            matches = [i for i in items if i.product == name]
        if not matches:
            print(f"  SKIP {name} — item introuvable dans items.json")
            errors += 1
            continue

        target = matches[0]
        print(f"  Revert: {name}...")
        cooked_dir = Path(args.cooked_dir) if getattr(args, "cooked_dir", None) else COOKED
        rc = _do_revert(target, cooked_dir)
        if rc != 0:
            errors += 1

    log_entry({"op": "revert-all", "count": len(active), "errors": errors, "ok": errors == 0})
    print(f"Revert-all termine. {len(active)-errors}/{len(active)} OK.")
    return 0 if errors == 0 else 1


def cmd_list(args):
    active = active_swaps()
    if not active:
        print("Aucun swap actif.")
        return 0
    print(f"Swaps actifs ({len(active)}):")
    for name, s in active.items():
        print(f"  {name} affiche comme {s['source']}  ({s['ts'][:16]})")
    return 0


def cmd_search(args, items):
    results = search_items(items, args.query)
    if not results:
        print(f"Aucun resultat pour '{args.query}'")
        return 1
    print(f"{len(results)} resultat(s):")
    for i in results[:40]:
        print(f"  {fmt_item(i)}")
    return 0


def cmd_browse(args, items):
    slot = args.slot.lower()
    results = [i for i in items if (i.slot or "").lower() == slot]
    if not results:
        # Afficher les slots disponibles
        slots = sorted(set(i.slot for i in items if i.slot))
        print(f"Slot '{args.slot}' introuvable. Slots disponibles:")
        for s in slots:
            print(f"  {s}")
        return 1
    print(f"{len(results)} items dans le slot '{args.slot}':")
    for i in results[:60]:
        print(f"  [{i.id}] {i.product} ({i.asset_package})")
    if len(results) > 60:
        print(f"  ... et {len(results)-60} autres. Affine avec search.")
    return 0


def cmd_slots(args, items):
    from collections import Counter
    counts = Counter(i.slot or "(vide)" for i in items)
    print("Slots disponibles:")
    for slot, count in sorted(counts.items()):
        print(f"  {slot:<30} {count} items")
    return 0


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(prog="rl-swap", description="RL UPK Swap CLI")
    p.add_argument("--cooked-dir", default=str(COOKED), help="Rocket League CookedPCConsole directory")
    sub = p.add_subparsers(dest="cmd", required=True)

    sw = sub.add_parser("swap", help="Appliquer un swap")
    sw.add_argument("--source", required=True, help="Item donneur (nom/id/package)")
    sw.add_argument("--target", required=True, help="Item cible (nom/id/package)")

    rv = sub.add_parser("revert", help="Annuler un swap")
    rv.add_argument("--target", required=True, help="Item a restaurer (nom/id)")

    sub.add_parser("revert-all", help="Annuler tous les swaps actifs")

    sub.add_parser("list", help="Lister les swaps actifs")

    sr = sub.add_parser("search", help="Chercher un item")
    sr.add_argument("query", help="Nom, ID ou package")

    br = sub.add_parser("browse", help="Lister les items d'un slot")
    br.add_argument("--slot", required=True, help="Ex: Decal, Body, Wheel...")

    sub.add_parser("slots", help="Lister tous les slots disponibles")

    args = p.parse_args()
    items = load_items(HERE / "items.json")

    if args.cmd == "swap":        return cmd_swap(args, items)
    if args.cmd == "revert":      return cmd_revert(args, items)
    if args.cmd == "revert-all":  return cmd_revert_all(args, items)
    if args.cmd == "list":        return cmd_list(args)
    if args.cmd == "search":      return cmd_search(args, items)
    if args.cmd == "browse":      return cmd_browse(args, items)
    if args.cmd == "slots":       return cmd_slots(args, items)


if __name__ == "__main__":
    sys.exit(main() or 0)