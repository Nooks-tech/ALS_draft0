import test from "node:test";
import assert from "node:assert/strict";
import { isLocalOnlyRequest, isPrivateIp } from "../utils/nooksInternal";

test("isPrivateIp recognises local and RFC1918 addresses", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:192.168.1.20"), true);
  assert.equal(isPrivateIp("172.20.10.5"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("isLocalOnlyRequest allows localhost and private network callers", () => {
  const localhostReq = {
    headers: { host: "localhost:3001", "x-forwarded-for": "" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const privateReq = {
    headers: { host: "api.internal", "x-forwarded-for": "10.0.0.15" },
    socket: { remoteAddress: "10.0.0.15" },
  };
  const remoteReq = {
    headers: { host: "api.example.com", "x-forwarded-for": "8.8.8.8" },
    socket: { remoteAddress: "8.8.8.8" },
  };

  assert.equal(isLocalOnlyRequest(localhostReq as never), true);
  assert.equal(isLocalOnlyRequest(privateReq as never), true);
  assert.equal(isLocalOnlyRequest(remoteReq as never), false);
});
