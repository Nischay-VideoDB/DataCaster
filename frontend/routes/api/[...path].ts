import { defineEventHandler, setResponseStatus } from "nitro/h3";

export default defineEventHandler((event) => {
  setResponseStatus(event, 404);
  return {
    error: "No DataCaster API route matches this request.",
    code: "API_ROUTE_NOT_FOUND",
    guidance: "Check the HTTP method and path against docs/API.md. API requests never fall through to the SPA document.",
  };
});
