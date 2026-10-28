#!/usr/bin/env python3
"""Named local D4 fixture, through public APIs only. Secrets stay in private ignored state."""
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PERSONAS = {
    "requester": ("Alyssa Tan", "d4.requester", "REQUESTER"),
    "courier": ("Ben Lim", "d4.courier", "COURIER"),
    "raceCourier": ("Chloe Ng", "d4.race.courier", "COURIER"),
    "adminA": ("Dina Koh", "d4.admin.a", None),
    "adminB": ("Evan Teo", "d4.admin.b", None),
}
STORIES = {
    "prints": ("CS3219 project prints from SoC to PGP", 2),
    "cancel": ("Project reading notes — cancellation example", 1),
    "race": ("Project poster — two couriers, one acceptance", 1),
}
ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".demo-state/foc-d4-demo"


class ApiError(Exception):
    def __init__(self, status, code, path):
        self.status, self.code = status, code
        super().__init__(f"{path}: HTTP {status} {code}")


class Api:
    def __init__(self, edge):
        parsed = urllib.parse.urlparse(edge)
        if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("Demo seeding requires a local HTTP edge")
        self.edge = edge.rstrip("/")

    def call(self, method, path, data=None, token=None, key=None):
        headers = {"Content-Type": "application/json", "Origin": self.edge}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(self.edge + path,
            data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            try:
                code = json.loads(error.read()).get("error", {}).get("code", "HTTP_ERROR")
            except (ValueError, AttributeError):
                code = "HTTP_ERROR"
            raise ApiError(error.code, code, path) from None


def wait_for(read, accept, label, seconds=45):
    deadline = time.monotonic() + seconds
    while True:
        try:
            result = read()
            if accept(result):
                return result
        except (ApiError, urllib.error.URLError):
            pass
        if time.monotonic() >= deadline:
            raise ValueError(f"Timed out waiting for {label}")
        time.sleep(0.3)


def private_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def credentials(domain, create):
    path = STATE / "credentials.json"
    if path.exists():
        record = json.loads(path.read_text())
        if record.get("domain") != domain or set(record.get("personas", {})) != set(PERSONAS):
            raise ValueError("Demo credentials do not match this domain/fixture; use a fresh demo project")
        return record["personas"]
    if not create:
        raise ValueError("No demo credentials. Run ./scripts-seed-demo.sh --up first")
    people = {key: {"name": name, "email": f"{local}@{domain}", "password": secrets.token_urlsafe(24)}
              for key, (name, local, _mode) in PERSONAS.items()}
    private_json(path, {"domain": domain, "personas": people})
    return people


def sign_in(api, person):
    return api.call("POST", "/api/user/auth/login", {"email": person["email"], "password": person["password"]})


def ensure_person(api, key, person, create):
    student = PERSONAS[key][2] is not None
    try:
        login = sign_in(api, person)
    except ApiError as error:
        if not create or error.status not in (401, 403):
            raise
        if student:
            if error.status == 401:
                api.call("POST", "/api/user/auth/register", {
                    "email": person["email"], "password": person["password"], "displayName": person["name"]})
            elif error.code != "ACCOUNT_NOT_ACTIVATED":
                raise
            mail = api.call("GET", "/api/user/dev/mailbox?" + urllib.parse.urlencode({"to": person["email"]}))
            if not mail.get("token"):
                raise ValueError("The local activation mailbox has no token; recreate only the disposable demo project")
            api.call("POST", "/api/user/auth/activate", {"token": mail["token"]})
        else:
            try:
                api.call("POST", "/api/user/auth/login", {
                    "email": person["email"], "password": os.environ["ADMIN_SEED_PASSWORD"]})
            except ApiError as bootstrap_error:
                if bootstrap_error.code != "PASSWORD_CHANGE_REQUIRED":
                    raise ValueError("Demo administrator is not in the expected fresh bootstrap state") from None
            else:
                raise ValueError("Bootstrap administrator unexpectedly allowed a session")
            api.call("POST", "/api/user/auth/password", {"email": person["email"],
                     "currentPassword": os.environ["ADMIN_SEED_PASSWORD"], "newPassword": person["password"]})
        login = sign_in(api, person)
    token, user = login["accessToken"], login["user"]
    expected = "STUDENT" if student else "ADMIN"
    if expected not in user["roles"]:
        raise ValueError(f"Wrong role for {key}")
    if create:
        profile = {"displayName": person["name"]}
        if student:
            profile["preferredMode"] = PERSONAS[key][2]
        api.call("PATCH", "/api/user/users/me", profile, token)
    me = api.call("GET", "/api/user/users/me", token=token)
    if me["profile"]["displayName"] != person["name"] or me["status"] != "ACTIVE":
        raise ValueError(f"Wrong name/status for {key}")
    if student:
        wait_for(lambda: api.call("GET", "/api/credit/wallets/me", token=token),
                 lambda wallet: wallet["total"] > 0, f"{key}'s issued wallet")
    return token, me


def main():
    if os.environ.get("COMPOSE_PROJECT_NAME") != "foc-d4-demo" or os.environ.get("NODE_ENV") != "development":
        raise ValueError("Use the isolated development wrapper ./scripts-seed-demo.sh")
    create = len(sys.argv) == 2 and sys.argv[1] == "--up"
    api = Api(os.environ["D4_EDGE_URL"])
    wait_for(lambda: api.call("GET", "/edge/ready"), lambda _result: True, "the full application")
    # Before registering anyone, prove this is the local development mailbox, not a real mail flow.
    api.call("GET", "/api/user/dev/mailbox")
    people = credentials(os.environ["ALLOWED_EMAIL_DOMAINS"].split(",")[0], create)
    sessions = {key: ensure_person(api, key, person, create) for key, person in people.items()}
    requester = sessions["requester"][0]
    suppliers = api.call("GET", "/api/supplier/suppliers?pageSize=100", token=requester)
    printing = [s for s in suppliers["items"] if s["type"] == "PRINTING" and s["name"] == "Printer @ Com 2"]
    if not printing:
        raise ValueError("The course-template pickup point Printer @ Com 2 is missing from the catalogue")
    supplier = printing[0]
    prior_path = STATE / "overview.json"
    prior = json.loads(prior_path.read_text()) if prior_path.exists() else {}
    orders = {}
    for key, (title, reward) in STORIES.items():
        if create:
            order = api.call("POST", "/api/order/orders", {"supplierId": supplier["supplierId"],
                "items": [{"name": title, "quantity": 1}], "deliveryZone": "PGP House 7",
                "deliveryInstructions": "Meet at the PGP House 7 lobby counter.", "reward": reward},
                requester, f"d4-v1-{key}")
            order_id = order["orderId"]
        else:
            order_id = prior.get("orders", {}).get(key, {}).get("orderId")
            if not order_id:
                raise ValueError(f"Missing {key} errand; run --up first")
        order = wait_for(lambda: api.call("GET", f"/api/order/orders/{order_id}?view=private", token=requester),
                         lambda item: item["status"] != "PENDING_CREDIT", f"{key} credit reservation")
        if order["status"] == "REJECTED":
            raise ValueError(f"{key} was rejected; a fresh demo requires the configured initial allocation")
        orders[key] = {"orderId": order_id, "title": title, "reward": reward, "status": order["status"]}
    audit = api.call("POST", "/api/credit/admin/ledger-audits/run", {}, sessions["adminA"][0])["run"]
    if audit["status"] != "PASS" or audit["mismatchCount"] != 0:
        raise ValueError("Financial audit is not clean")
    overview = {"edge": api.edge, "project": "foc-d4-demo", "personas": {
        key: {"name": person["name"], "email": person["email"], "userId": sessions[key][1]["id"]}
        for key, person in people.items()}, "supplier": {"name": supplier["name"], "supplierId": supplier["supplierId"]},
        "orders": orders, "financialAudit": {"runId": audit["runId"], "status": audit["status"]}}
    private_json(prior_path, overview)
    print("D4 demo smoke passed: five named active personas, printing pickup point, three errands, clean financial audit.")
    print(f"Open {api.edge}/login and {api.edge}/admin/operations")
    print(f"Private login credentials: {STATE / 'credentials.json'}")
    print(f"Persona / errand IDs: {prior_path}")
    for key, order in orders.items():
        print(f"{key}: {order['status']} {api.edge}/request/{order['orderId']}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, ApiError) as error:
        print(f"D4 demo failed: {error}", file=sys.stderr)
        sys.exit(1)
