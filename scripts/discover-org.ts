/**
 * Discover the Yandex organization id(s) the current user belongs to, WITHOUT
 * admin access. Works for Yandex Cloud organizations (X-Cloud-Org-Id) by
 * exchanging the OAuth token for an IAM token and listing organizations.
 *
 * If this prints organizations -> use one's `id` as the `X-Cloud-Org-Id` header
 * for Tracker (and re-test /v3/myself).
 * If it prints none -> the org is likely a Yandex 360 org; its id (X-Org-Id)
 *   must be obtained from the org admin (Tracker -> Administration ->
 *   Organizations), there is no member-level API for it.
 *
 * Usage: ACCESS_TOKEN=<oauth access token> bun run scripts/discover-org.ts
 */
const ACCESS_TOKEN = process.env.ACCESS_TOKEN ?? ""
if (!ACCESS_TOKEN) {
  console.error("Set ACCESS_TOKEN env var (the OAuth access token from fetch-token.ts).")
  process.exit(1)
}

const iamResp = await fetch("https://iam.api.cloud.yandex.net/iam/v1/tokens", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ yandexPassportOauthToken: ACCESS_TOKEN }),
})
if (!iamResp.ok) {
  console.error(`IAM exchange failed (${iamResp.status}): ${await iamResp.text()}`)
  console.error("This usually means the org is Yandex 360 (not Cloud) — see note below.")
  process.exit(2)
}
const iam = (await iamResp.json()) as { iamToken: string }
console.log("IAM token obtained.\n")

const orgsResp = await fetch("https://organization.api.cloud.yandex.net/organization-manager/v1/organizations", {
  headers: { Authorization: `Bearer ${iam.iamToken}` },
})
if (!orgsResp.ok) {
  console.error(`List organizations failed (${orgsResp.status}): ${await orgsResp.text()}`)
  console.error("Likely a Yandex 360 org — see note below.")
  process.exit(3)
}
const data = (await orgsResp.json()) as { organizations?: Array<{ id: string; name?: string; title?: string }> }
const orgs = data.organizations ?? []

if (orgs.length === 0) {
  console.log("No Yandex Cloud organizations found for this account.")
  console.log("The org is most likely a Yandex 360 org — ask its admin for the id")
  console.log("(Tracker -> Administration -> Organizations), then use it as `X-Org-Id`.")
  process.exit(0)
}

console.log(`Found ${orgs.length} organization(s):\n`)
for (const org of orgs) {
  console.log(`  X-Cloud-Org-Id: ${org.id}  —  ${org.title ?? org.name ?? "(no name)"}`)
}
console.log("\nRe-test Tracker with one of these, e.g.:")
console.log("  curl https://api.tracker.yandex.net/v3/myself \\")
console.log("    -H 'Authorization: OAuth $ACCESS_TOKEN' \\")
console.log("    -H 'X-Cloud-Org-Id: <id-from-above>'")
