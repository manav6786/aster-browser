// Copyright (c) 2026 Aster contributors. MIT licensed; see ../LICENSE.
// Public AppKit metadata for scroll events in this browser's own key window.
// This monitor never consumes/modifies events and never observes another app.
#include <node_api.h>
#import <AppKit/AppKit.h>
#include <deque>
#include <cstring>
#include <cmath>

namespace {
struct ScrollPhase {
  uint32_t phase;
  uint32_t momentum;
  double timestamp;
  bool precise;
  uint64_t gesture;
};
struct PhaseOwner {
  __weak NSView *source = nil;
  __weak NSWindow *window = nil;
  __strong id monitor = nil;
  std::deque<ScrollPhase> events;
  bool disposed = false;
  uint64_t gesture = 0;
};
napi_value Undefined(napi_env env) { napi_value v; napi_get_undefined(env, &v); return v; }
napi_value Fail(napi_env env, const char *message) { napi_throw_error(env, "ASTER_GESTURE_PHASES", message); return nullptr; }
bool MainThread(napi_env env) { if ([NSThread isMainThread]) return true; Fail(env, "Gesture phase access requires the AppKit main thread"); return false; }
void Number(napi_env env, napi_value object, const char *key, double value) { napi_value v; napi_create_double(env, value, &v); napi_set_named_property(env, object, key, v); }
void Boolean(napi_env env, napi_value object, const char *key, bool value) { napi_value v; napi_get_boolean(env, value, &v); napi_set_named_property(env, object, key, v); }
void Cleanup(PhaseOwner *owner) {
  if (!owner || owner->disposed) return;
  owner->disposed = true;
  if (owner->monitor) [NSEvent removeMonitor:owner->monitor];
  owner->monitor = nil; owner->events.clear(); owner->source = nil; owner->window = nil;
}
void Finalize(napi_env, void *data, void *) {
  auto *owner = static_cast<PhaseOwner *>(data);
  if ([NSThread isMainThread]) { Cleanup(owner); delete owner; }
  else dispatch_async(dispatch_get_main_queue(), ^{ Cleanup(owner); delete owner; });
}
PhaseOwner *Owner(napi_env env, napi_value value) {
  void *data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) { Fail(env, "Expected an owned gesture phase token"); return nullptr; }
  return static_cast<PhaseOwner *>(data);
}
napi_value Attach(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  bool buffer = false; void *bytes = nullptr; size_t length = 0;
  if (count != 1 || napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer || napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *)) return Fail(env, "Expected Electron's native NSView handle buffer");
  void *address = nullptr; std::memcpy(&address, bytes, sizeof(address));
  NSView *source = (__bridge NSView *)address;
  if (!source || ![source isKindOfClass:[NSView class]] || !source.window) return Fail(env, "Native content view is detached");
  auto *owner = new PhaseOwner(); owner->source = source; owner->window = source.window;
  owner->monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:^NSEvent *(NSEvent *event) {
    NSWindow *window = owner->window;
    if (!owner->disposed && window && owner->source.window == window && event.window == window && window.isKeyWindow) {
      if ((event.phase & NSEventPhaseBegan) && event.momentumPhase == NSEventPhaseNone) owner->gesture++;
      if (owner->events.size() >= 256) owner->events.pop_front();
      owner->events.push_back({static_cast<uint32_t>(event.phase), static_cast<uint32_t>(event.momentumPhase), event.timestamp, static_cast<bool>(event.hasPreciseScrollingDeltas), owner->gesture});
    }
    return event;
  }];
  if (!owner->monitor) { Cleanup(owner); delete owner; return Fail(env, "AppKit could not create the local phase monitor"); }
  napi_value token; napi_create_external(env, owner, Finalize, nullptr, &token); return token;
}
napi_value Drain(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1) return Fail(env, "Expected a gesture phase token");
  auto *owner = Owner(env, args[0]); if (!owner) return nullptr;
  napi_value result; napi_create_array(env, &result);
  if (owner->disposed || !owner->source || !owner->window || owner->source.window != owner->window) { owner->events.clear(); return result; }
  const double uptime = NSProcessInfo.processInfo.systemUptime;
  uint32_t index = 0;
  for (const auto &event : owner->events) {
    // No stale gesture captured while no page could navigate may arm a later
    // page. Both values use AppKit's monotonic system uptime time base.
    const double age = (uptime - event.timestamp) * 1000.0;
    if (age < -1.0 || age > 1000.0) continue;
    napi_value item; napi_create_object(env, &item);
    Number(env, item, "phase", event.phase); Number(env, item, "momentum", event.momentum);
    Number(env, item, "ageMs", age); Number(env, item, "gestureId", event.gesture); Boolean(env, item, "precise", event.precise);
    napi_set_element(env, result, index++, item);
  }
  owner->events.clear(); return result;
}
napi_value Sample(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 2; napi_value args[2]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  double epochMs = 0;
  if (count != 2 || napi_get_value_double(env, args[1], &epochMs) != napi_ok || !std::isfinite(epochMs)) return Fail(env, "Expected an owned token and event timestamp");
  auto *owner = Owner(env, args[0]); if (!owner) return nullptr;
  if (owner->disposed || !owner->source || !owner->window || owner->source.window != owner->window) return Undefined(env);
  const double uptime = NSProcessInfo.processInfo.systemUptime;
  const double epochOffset = NSDate.date.timeIntervalSince1970 - uptime;
  const ScrollPhase *best = nullptr; double distance = 80.0;
  for (const auto &event : owner->events) {
    if (uptime - event.timestamp > 1.0) continue;
    const double delta = std::abs((event.timestamp + epochOffset) * 1000.0 - epochMs);
    if (delta <= distance) { distance = delta; best = &event; }
  }
  if (!best) return Undefined(env);
  napi_value result; napi_create_object(env, &result);
  Number(env, result, "phase", best->phase); Number(env, result, "momentum", best->momentum);
  Number(env, result, "gestureId", best->gesture); Number(env, result, "distanceMs", distance); Boolean(env, result, "precise", best->precise);
  return result;
}
napi_value Dispose(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count == 1) { auto *owner = Owner(env, args[0]); if (!owner) return nullptr; Cleanup(owner); }
  return Undefined(env);
}
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {{"attach", nullptr, Attach, nullptr, nullptr, nullptr, napi_default, nullptr}, {"drain", nullptr, Drain, nullptr, nullptr, nullptr, napi_default, nullptr}, {"sample", nullptr, Sample, nullptr, nullptr, nullptr, napi_default, nullptr}, {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 4, methods); return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
