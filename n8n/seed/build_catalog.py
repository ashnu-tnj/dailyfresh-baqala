#!/usr/bin/env python3
"""Generate the DailyFresh seed catalogue.

Writes two files from one definition so they can never drift:
  docs/baqala-price-sheet-template.csv  - the Google Sheet Baqala will maintain
  n8n/seed/df_catalog.seed.json         - rows to load into df_catalog for testing

PRICES ARE PLACEHOLDERS for demo purposes and must be replaced with Baqala's real
figures before the client sees this.
"""
import csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# (group, item, category, unit, aliases, [(pack_label, price), ...])
PRODUCTS = [
    ("TOM", "Tomatoes",      "Vegetables",    "kg",    "tamatar,thakkali,tomato,tomatos",   [("250 g", 2.50), ("500 g", 4.00), ("1 kg", 6.50)]),
    ("ONI", "Onions",        "Vegetables",    "kg",    "pyaaz,vengayam,onion",              [("1 kg", 4.00), ("2 kg", 7.00)]),
    ("POT", "Potatoes",      "Vegetables",    "kg",    "aloo,urulai,potato",                [("1 kg", 4.50), ("2 kg", 8.00)]),
    ("CUC", "Cucumber",      "Vegetables",    "kg",    "kheera,vellarikka",                 [("500 g", 3.00), ("1 kg", 5.00)]),
    ("CAR", "Carrots",       "Vegetables",    "kg",    "gajar,carrot",                      [("500 g", 3.50), ("1 kg", 6.00)]),
    ("CAP", "Capsicum",      "Vegetables",    "kg",    "shimla mirch,bell pepper,capsicum", [("250 g", 3.00), ("500 g", 5.50)]),
    ("OKR", "Okra",          "Vegetables",    "kg",    "bhindi,vendakkai,ladies finger",    [("500 g", 5.00)]),
    ("BRJ", "Brinjal",       "Vegetables",    "kg",    "baingan,kathirikai,eggplant",       [("500 g", 4.00), ("1 kg", 7.00)]),
    ("CAU", "Cauliflower",   "Vegetables",    "pc",    "gobi,phool gobi",                   [("1 head", 6.00)]),
    ("CAB", "Cabbage",       "Vegetables",    "pc",    "patta gobi,muttaikose",             [("1 head", 5.00)]),
    ("COR", "Coriander",     "Herbs & Salad", "bunch", "kothmir,malli,dhania,cilantro",     [("1 bunch", 2.00)]),
    ("MNT", "Mint",          "Herbs & Salad", "bunch", "pudina,nana",                       [("1 bunch", 2.00)]),
    ("PAR", "Parsley",       "Herbs & Salad", "bunch", "baqdounis",                         [("1 bunch", 2.50)]),
    ("LET", "Lettuce",       "Herbs & Salad", "pc",    "salad leaves,iceberg",              [("1 head", 5.50)]),
    ("SPO", "Spring Onion",  "Herbs & Salad", "bunch", "hara pyaaz,scallion",               [("1 bunch", 3.00)]),
    ("BAN", "Bananas",       "Fruits",        "kg",    "kela,vazhaipazham,banana",          [("1 kg", 6.00)]),
    ("APP", "Apples",        "Fruits",        "kg",    "seb,apple",                         [("1 kg", 9.00)]),
    ("ORA", "Oranges",       "Fruits",        "kg",    "santra,orange",                     [("1 kg", 8.00), ("2 kg", 15.00)]),
    ("MAN", "Mangoes",       "Fruits",        "kg",    "aam,mampazham,mango",               [("1 kg", 12.00)]),
    ("GRP", "Grapes",        "Fruits",        "box",   "angoor,grape",                      [("500 g", 9.50)]),
    ("STR", "Strawberries",  "Fruits",        "box",   "strawberry",                        [("250 g", 11.00), ("1 box", 18.00)]),
    ("WAT", "Watermelon",    "Fruits",        "pc",    "tarbooz,batikh",                    [("1 whole", 14.00)]),
    ("ARB", "Arabic Bread",  "Bakery",        "pack",  "khubz,pita,roti",                   [("1 pack", 3.00)]),
    ("WHB", "White Bread",   "Bakery",        "loaf",  "bread,loaf",                        [("1 loaf", 4.50)]),
    ("CRO", "Croissant",     "Bakery",        "pc",    "croissants",                        [("1 pc", 3.50), ("4 pc", 12.00)]),
    ("VBS", "Small Veggie Box", "Veggie Box", "box",   "veg box,vegetable box,small box",   [("1 box", 35.00)]),
    ("VBF", "Family Veggie Box", "Veggie Box", "box",  "family box,big box",                [("1 box", 65.00)]),
    ("EGG", "Eggs",          "Groceries",     "tray",  "anda,muttai,egg",                   [("6 pcs", 6.00), ("30 pcs", 24.00)]),
    ("MLK", "Milk",          "Groceries",     "ltr",   "doodh,paal,milk",                   [("1 L", 6.50), ("2 L", 12.00)]),
    ("RIC", "Basmati Rice",  "Groceries",     "kg",    "chawal,arisi,rice",                 [("5 kg", 32.00)]),
    ("SUG", "Sugar",         "Groceries",     "kg",    "cheeni,sakkarai",                   [("1 kg", 5.00)]),
]

PACK_CODE = {
    "250 g": "250", "500 g": "500", "1 kg": "1K", "2 kg": "2K", "5 kg": "5K",
    "1 bunch": "BN", "1 head": "HD", "1 whole": "WH", "1 box": "BX",
    "1 pack": "PK", "1 loaf": "LF", "1 pc": "P1", "4 pc": "P4",
    "6 pcs": "P6", "30 pcs": "P30", "1 L": "L1", "2 L": "L2",
}


def rows():
    sort = 0
    for group, item, category, unit, aliases, packs in PRODUCTS:
        for pack_label, price in packs:
            sort += 10
            suffix = PACK_CODE.get(pack_label)
            if not suffix:
                raise SystemExit("No pack code mapped for %r" % pack_label)
            yield {
                "item_code": group + suffix,
                "group_code": group,
                "item_name": item,
                "pack_label": pack_label,
                "unit": unit,
                "category": category,
                "price": price,
                "listed": True,
                "out_of_stock": False,
                "aliases": aliases,
                "search_text": (" ".join([item, pack_label, category, aliases.replace(",", " ")])).lower(),
                "sort_order": sort,
            }


def main():
    data = list(rows())
    codes = [r["item_code"] for r in data]
    dupes = {c for c in codes if codes.count(c) > 1}
    if dupes:
        raise SystemExit("Duplicate item codes: %s" % sorted(dupes))

    out_json = os.path.join(HERE, "df_catalog.seed.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"_comment": "PLACEHOLDER demo prices - replace with Baqala's real price list.",
                   "rows": data}, f, indent=1)

    out_csv = os.path.join(ROOT, "docs", "baqala-price-sheet-template.csv")
    header = ["Code", "Group", "Item", "Pack", "Unit", "Category",
              "Price (AED)", "Listed", "Out of stock", "Also called", "Sort"]
    with open(out_csv, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for r in data:
            w.writerow([r["item_code"], r["group_code"], r["item_name"], r["pack_label"],
                        r["unit"], r["category"], "%.2f" % r["price"],
                        "yes" if r["listed"] else "no",
                        "yes" if r["out_of_stock"] else "no",
                        r["aliases"], r["sort_order"]])

    groups = len({r["group_code"] for r in data})
    cats = sorted({r["category"] for r in data})
    print("%d rows, %d products, %d categories" % (len(data), groups, len(cats)))
    print("categories: " + ", ".join(cats))
    print("wrote " + out_json)
    print("wrote " + out_csv)


if __name__ == "__main__":
    main()
