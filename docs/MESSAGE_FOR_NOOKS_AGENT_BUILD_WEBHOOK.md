# Message for Nooks / nooksweb agent: configure build webhook

**Copy the text below into the chat with the other agent (or into Nooks docs).**

---

## Build webhook – what to configure in Nooks

We (ALS_draft0) have a **build webhook** that Nooks must call after a merchant pays, so we can trigger Android + iOS app builds with that merchant’s branding.

### 1. Webhook URL (in Nooks env or config)

Set:

**`BUILD_SERVICE_WEBHOOK_URL`** = `https://<OUR_API_BASE>/build`

- Replace `<OUR_API_BASE>` with the public base URL of our API once we deploy it (e.g. `https://als-api.railway.app` or whatever host we use).
- We will send you the final URL when the server is live. Alternatively, once you know our API base, you can call **GET** `https://<OUR_API_BASE>/build` and use the **`webhook_url`** from the JSON response.

### 2. Secret header (required – we use it)

We use a shared secret so only Nooks can trigger builds. On every **POST** to the webhook URL, Nooks must send this header:

**Header name:** `x-nooks-secret`  
**Header value:** (use this exact string)

```
4d1eb3621b41930d0fc512f1ab2ff0498a0de5030019c682892f10eb28033af1
```

If this header is missing or wrong, our server returns **401 Unauthorized**.

### 3. Request format

- **Method:** POST  
- **URL:** value of `BUILD_SERVICE_WEBHOOK_URL` (above)  
- **Headers:**  
  - `Content-Type: application/json`  
  - `x-nooks-secret: 4d1eb3621b41930d0fc512f1ab2ff0498a0de5030019c682892f10eb28033af1`  
- **Body (JSON):**  
  - `merchant_id` (required, string)  
  - `logo_url` (optional, string)  
  - `primary_color` (optional, string, e.g. `#0D9488`)  
  - `accent_color` (optional, string)

Example body:

```json
{
  "merchant_id": "uuid-of-merchant",
  "logo_url": "https://example.com/logo.png",
  "primary_color": "#0D9488",
  "accent_color": "#0D9488"
}
```

We respond with **202 Accepted** and then trigger the build asynchronously.

---

**Summary for Nooks agent:** Configure `BUILD_SERVICE_WEBHOOK_URL` to our `/build` URL (we’ll provide the base when deployed). Send the secret above in the `x-nooks-secret` header on every POST. Use the JSON body format above.
