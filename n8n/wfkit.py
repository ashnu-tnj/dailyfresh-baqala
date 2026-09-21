#!/usr/bin/env python3
"""Shared helpers for generating n8n workflow JSON.

Node type versions here are the ones this instance actually runs - they were read
back off a working workflow rather than guessed, so don't "upgrade" them without
checking the instance first.
"""

IF = ("n8n-nodes-base.if", 2.3)
CODE = ("n8n-nodes-base.code", 2)
WEBHOOK = ("n8n-nodes-base.webhook", 2.1)
RESPOND = ("n8n-nodes-base.respondToWebhook", 1.5)
FILTER = ("n8n-nodes-base.filter", 2.3)
HTTP = ("n8n-nodes-base.httpRequest", 4.5)
DATATABLE = ("n8n-nodes-base.dataTable", 1.1)
SWITCH = ("n8n-nodes-base.switch", 3.2)
NOOP = ("n8n-nodes-base.noOp", 1)


class Builder(object):
    def __init__(self):
        self.nodes = []
        self.conns = {}

    def node(self, name, kind, params, x, y, **extra):
        ntype, version = kind
        n = {"parameters": params,
             "id": name.lower().replace(" ", "-").replace("?", "").replace("/", "-"),
             "name": name, "type": ntype, "typeVersion": version, "position": [x, y]}
        n.update(extra)
        self.nodes.append(n)
        return name

    def link(self, src, dst, out=0):
        self.conns.setdefault(src, {}).setdefault("main", [])
        while len(self.conns[src]["main"]) <= out:
            self.conns[src]["main"].append([])
        self.conns[src]["main"][out].append({"node": dst, "type": "main", "index": 0})

    def check(self, entry):
        names = [n["name"] for n in self.nodes]
        dupes = {n for n in names if names.count(n) > 1}
        if dupes:
            raise SystemExit("Duplicate node names: %s" % sorted(dupes))
        targets = set()
        for src, c in self.conns.items():
            if src not in names:
                raise SystemExit("Connection from unknown node: %s" % src)
            for out in c["main"]:
                for t in out:
                    targets.add(t["node"])
        unknown = targets - set(names)
        if unknown:
            raise SystemExit("Connections point at unknown nodes: %s" % sorted(unknown))
        return [n for n in names if n not in targets and n != entry]

    def workflow(self, name):
        return {"name": name, "nodes": self.nodes, "connections": self.conns,
                "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                             "saveDataErrorExecution": "all", "saveDataSuccessExecution": "all"}}


def cond_str(left, op, right):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "c1", "leftValue": left,
                            "operator": {"type": "string", "operation": op},
                            "rightValue": right}],
            "combinator": "and"}


def cond_bool(left, op="true"):
    return {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "c1", "leftValue": left,
                            "operator": {"type": "boolean", "operation": op, "singleValue": True}}],
            "combinator": "and"}


def dt_get(table, filters=None, return_all=True, limit=1):
    p = {"resource": "row", "operation": "get",
         "dataTableId": {"__rl": True, "mode": "name", "value": table},
         "returnAll": return_all}
    if filters:
        p["matchType"] = "allConditions"
        p["filters"] = {"conditions": filters}
    if not return_all:
        p["limit"] = limit
    return p


def dt_upsert(table, match_col, key_expr=None):
    return {"resource": "row", "operation": "upsert",
            "dataTableId": {"__rl": True, "mode": "name", "value": table},
            "matchType": "allConditions",
            "filters": {"conditions": [{"keyName": match_col, "condition": "eq",
                                        "keyValue": key_expr or ("={{ $json['" + match_col + "'] }}")}]},
            "columns": {"mappingMode": "autoMapInputData", "matchingColumns": [match_col], "schema": []},
            "options": {"dryRun": False}}


def respond_json(expr="={{ JSON.stringify($json) }}", code=200):
    return {"respondWith": "text", "responseBody": expr,
            "options": {"responseCode": code,
                        "responseHeaders": {"entries": [
                            {"name": "Content-Type", "value": "application/json"}]}}}
