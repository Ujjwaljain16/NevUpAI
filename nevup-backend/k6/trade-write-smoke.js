import http from "k6/http";
import { check } from "k6";

export const options = {
  vus: 5,
  duration: "10s",
};

export default function () {
  const res = http.get("http://localhost:3000/health");
  check(res, {
    "health endpoint is up": (r) => r.status === 200 || r.status === 503,
  });
}
