// Copyright (c) 2026 Aster contributors. MIT licensed; see ../LICENSE.
// Uses only public AppKit APIs. No event monitors, private selectors, or
// renderer/window focus changes are installed by this module.
#include <node_api.h>
#import <AppKit/AppKit.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>

@interface AsterGlassBackgroundHost : NSView
@end
@implementation AsterGlassBackgroundHost
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return NO; }
- (BOOL)acceptsFirstResponder { return NO; }
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

namespace {
struct GlassOwner {
  __weak NSView *source = nil;
  __weak NSWindow *window = nil;
  __strong AsterGlassBackgroundHost *host = nil;
  __strong NSGlassEffectContainerView *container = nil;
  __strong AsterGlassBackgroundHost *group = nil;
  __strong NSMutableArray<NSGlassEffectView *> *effects = nil;
  bool disposed = false;
  bool enabled = false;
};

napi_value Undefined(napi_env env) {
  napi_value value; napi_get_undefined(env, &value); return value;
}
napi_value Fail(napi_env env, const char *reason) {
  napi_throw_error(env, "ASTER_NATIVE_GLASS", reason); return nullptr;
}
bool MainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  Fail(env, "Native glass is available only on the AppKit main thread");
  return false;
}
bool Object(napi_env env, napi_value value) {
  napi_valuetype type; if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) return false;
  napi_value nullValue; bool isNull = false; napi_get_null(env, &nullValue); napi_strict_equals(env, value, nullValue, &isNull);
  return !isNull;
}
napi_value Property(napi_env env, napi_value object, const char *key) {
  napi_value value = Undefined(env);
  if (Object(env, object)) napi_get_named_property(env, object, key, &value);
  return value;
}
double Number(napi_env env, napi_value object, const char *key, double fallback) {
  double value; napi_value item = Property(env, object, key);
  return napi_get_value_double(env, item, &value) == napi_ok && std::isfinite(value) ? value : fallback;
}
bool Boolean(napi_env env, napi_value object, const char *key, bool fallback) {
  bool value; return napi_get_value_bool(env, Property(env, object, key), &value) == napi_ok ? value : fallback;
}
void SetBoolean(napi_env env, napi_value object, const char *key, bool value) {
  napi_value item; napi_get_boolean(env, value, &item); napi_set_named_property(env, object, key, item);
}
void SetString(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value item; napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &item); napi_set_named_property(env, object, key, item);
}
void SetNumber(napi_env env, napi_value object, const char *key, double value) {
  napi_value item; napi_create_double(env, value, &item); napi_set_named_property(env, object, key, item);
}
bool SupportsGlass() {
  if (@available(macOS 26.0, *)) return NSClassFromString(@"NSGlassEffectView") != Nil;
  return false;
}
bool Attached(GlassOwner *owner) {
  if (!owner || owner->disposed) return false;
  NSView *source = owner->source;
  NSWindow *window = owner->window;
  return source && window && source.window == window && window.contentView == source && source.superview && owner->host.superview == source.superview;
}
napi_value Status(napi_env env, GlassOwner *owner, const char *reason = nullptr) {
  napi_value result; napi_create_object(env, &result);
  bool available = owner ? Attached(owner) : SupportsGlass();
  SetBoolean(env, result, "available", available);
  SetBoolean(env, result, "enabled", owner && available && owner->enabled);
  SetString(env, result, "api", "NSGlassEffectView");
  SetString(env, result, "reason", reason ? reason : (available ? "ready" : "detached-or-disposed"));
  SetNumber(env, result, "viewCount", owner && owner->effects ? owner->effects.count : 0);
  return result;
}
void Cleanup(GlassOwner *owner) {
  if (!owner || owner->disposed) return;
  owner->disposed = true;
  owner->enabled = false;
  owner->host.hidden = YES;
  [owner->host removeFromSuperview];
  owner->effects = nil;
  owner->group = nil;
  owner->container = nil;
  owner->host = nil;
  owner->source = nil;
  owner->window = nil;
}
void Finalize(napi_env env, void *data, void *hint) {
  auto *owner = static_cast<GlassOwner *>(data);
  // Finalizers must never release AppKit views on a worker thread. The block
  // owns the allocation until main-thread cleanup has completed.
  if ([NSThread isMainThread]) { Cleanup(owner); delete owner; }
  else dispatch_async(dispatch_get_main_queue(), ^{ Cleanup(owner); delete owner; });
}
GlassOwner *GetOwner(napi_env env, napi_value token) {
  void *value = nullptr;
  if (napi_get_value_external(env, token, &value) != napi_ok || !value) {
    Fail(env, "Expected an owned native-glass token"); return nullptr;
  }
  return static_cast<GlassOwner *>(value);
}
NSRect Rect(napi_env env, napi_value object, CGFloat width, CGFloat height) {
  CGFloat x = std::clamp(Number(env, object, "x", 0), 0.0, static_cast<double>(width));
  CGFloat y = std::clamp(Number(env, object, "y", 0), 0.0, static_cast<double>(height));
  CGFloat w = std::clamp(Number(env, object, "width", 0), 0.0, static_cast<double>(width - x));
  CGFloat h = std::clamp(Number(env, object, "height", 0), 0.0, static_cast<double>(height - y));
  return NSMakeRect(x, y, w, h);
}
NSColor *Accent(napi_env env, napi_value options) {
  napi_value value = Property(env, options, "accent");
  char hex[8] = {}; size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length != 7) return nil;
  if (napi_get_value_string_utf8(env, value, hex, sizeof(hex), &length) != napi_ok || hex[0] != '#') return nil;
  for (int i = 1; i < 7; ++i) if (!std::isxdigit(static_cast<unsigned char>(hex[i]))) return nil;
  unsigned long rgb = std::strtoul(hex + 1, nullptr, 16);
  return [NSColor colorWithSRGBRed:((rgb >> 16) & 255) / 255.0 green:((rgb >> 8) & 255) / 255.0 blue:(rgb & 255) / 255.0 alpha:0.12];
}

napi_value Capabilities(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  return Status(env, nullptr, SupportsGlass() ? "supported" : "requires-macos-26");
}
napi_value Create(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  if (!SupportsGlass()) return Fail(env, "Public NSGlassEffectView requires macOS 26 or later");
  // Node outside Electron can load the addon for capability checks, but must
  // not turn arbitrary pointer bytes into an AppKit object.
  if (!NSApp) return Fail(env, "An initialized Electron AppKit application is required");
  napi_value args[1]; size_t argc = 1;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool isBuffer = false; void *bytes = nullptr; size_t length = 0;
  if (argc != 1 || napi_is_buffer(env, args[0], &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, args[0], &bytes, &length) != napi_ok || length != sizeof(void *))
    return Fail(env, "Expected Electron's fresh NSView pointer Buffer");
  void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) return Fail(env, "The native window handle is empty");
  // Electron v45's macOS implementation copies window.contentView (NSView*)
  // into this Buffer. The pointer is used only here; never retained as bytes.
  NSView *source = (__bridge NSView *)pointer;
  NSWindow *window = source.window;
  if (![source isKindOfClass:NSView.class] || !window || window.contentView != source || !source.superview)
    return Fail(env, "The handle is not the attached Electron content view");
  auto *owner = new GlassOwner();
  @try {
    if (@available(macOS 26.0, *)) {
      owner->source = source; owner->window = window;
      owner->host = [[AsterGlassBackgroundHost alloc] initWithFrame:source.frame];
      owner->host.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      [owner->host setAccessibilityElement:NO];
      [owner->host setAccessibilityHidden:YES];
      owner->container = [[NSGlassEffectContainerView alloc] initWithFrame:owner->host.bounds];
      owner->container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      owner->container.spacing = 0;
      owner->group = [[AsterGlassBackgroundHost alloc] initWithFrame:owner->host.bounds];
      owner->group.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
      owner->container.contentView = owner->group;
      [owner->host addSubview:owner->container];
      owner->effects = [NSMutableArray array];
      owner->host.hidden = YES;
      // Chromium paints the shell in the content NSView itself. A child of
      // that view would cover its pixels despite a "below subviews" ordering.
      // Keep the material a sibling below the whole content view instead.
      [source.superview addSubview:owner->host positioned:NSWindowBelow relativeTo:source];
    }
  } @catch (NSException *exception) {
    Cleanup(owner); delete owner; return Fail(env, "AppKit could not create the native glass background");
  }
  napi_value token;
  if (napi_create_external(env, owner, Finalize, nullptr, &token) != napi_ok) {
    Cleanup(owner); delete owner; return Fail(env, "Could not create the native-glass owner token");
  }
  return token;
}
napi_value Update(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  napi_value args[2]; size_t argc = 2; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || !Object(env, args[1])) return Fail(env, "Expected owner token and update options");
  GlassOwner *owner = GetOwner(env, args[0]); if (!owner) return nullptr;
  if (!owner->disposed && owner->source && owner->window && owner->source.window == owner->window && owner->window.contentView == owner->source && owner->source.superview && owner->host.superview != owner->source.superview) {
    [owner->host removeFromSuperview];
    [owner->source.superview addSubview:owner->host positioned:NSWindowBelow relativeTo:owner->source];
  }
  if (!Attached(owner)) { Cleanup(owner); return Status(env, owner, "window-detached"); }
  @try {
    if (@available(macOS 26.0, *)) {
      NSView *source = owner->source;
      owner->host.frame = source.frame;
      CGFloat width = source.bounds.size.width, height = source.bounds.size.height;
      owner->container.frame = owner->host.bounds; owner->group.frame = owner->host.bounds;
      owner->enabled = Boolean(env, args[1], "enabled", true);
      owner->host.hidden = !owner->enabled;
      owner->host.alphaValue = std::clamp(Number(env, args[1], "opacity", 1), 0.0, 1.0);
      owner->host.appearance = [NSAppearance appearanceNamed:Boolean(env, args[1], "dark", false) ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
      NSMutableArray<NSValue *> *rects = [NSMutableArray array];
      napi_value regions = Property(env, args[1], "regions"); bool isArray = false;
      napi_is_array(env, regions, &isArray);
      if (isArray) {
        uint32_t count = 0; napi_get_array_length(env, regions, &count);
        if (count > 8) return Fail(env, "At most eight native glass regions are supported");
        for (uint32_t i = 0; i < count; ++i) {
          napi_value region; napi_get_element(env, regions, i, &region);
          NSRect rect = Rect(env, region, width, height);
          if (rect.size.width > 0 && rect.size.height > 0) [rects addObject:[NSValue valueWithRect:rect]];
        }
      } else {
        napi_value content = Property(env, args[1], "contentBounds");
        if (Object(env, content)) {
          NSRect rect = Rect(env, content, width, height);
          NSRect chrome[] = {NSMakeRect(0, 0, width, rect.origin.y),
            NSMakeRect(0, NSMaxY(rect), width, height - NSMaxY(rect)),
            NSMakeRect(0, rect.origin.y, rect.origin.x, rect.size.height),
            NSMakeRect(NSMaxX(rect), rect.origin.y, width - NSMaxX(rect), rect.size.height)};
          for (const NSRect &part : chrome) if (part.size.width > 0 && part.size.height > 0) [rects addObject:[NSValue valueWithRect:part]];
        } else [rects addObject:[NSValue valueWithRect:NSMakeRect(0, 0, width, height)]];
      }
      while (owner->effects.count < rects.count) {
        NSGlassEffectView *effect = [[NSGlassEffectView alloc] initWithFrame:NSZeroRect];
        effect.style = NSGlassEffectViewStyleRegular;
        // Public interactivity arrived in macOS27. Background-only regions
        // deliberately leave it disabled, without invoking the newer setter.
        [owner->group addSubview:effect]; [owner->effects addObject:effect];
      }
      while (owner->effects.count > rects.count) {
        [owner->effects.lastObject removeFromSuperview]; [owner->effects removeLastObject];
      }
      NSColor *accent = Accent(env, args[1]);
      CGFloat radius = std::clamp(Number(env, args[1], "cornerRadius", 16), 0.0, 40.0);
      for (NSUInteger i = 0; i < rects.count; ++i) {
        NSGlassEffectView *effect = owner->effects[i];
        effect.frame = rects[i].rectValue;
        effect.cornerRadius = std::min(radius, std::min(effect.frame.size.width, effect.frame.size.height) / 2);
        effect.tintColor = accent;
      }
      [owner->host setNeedsLayout:YES];
    }
  } @catch (NSException *exception) {
    Cleanup(owner); return Fail(env, "AppKit could not update the native glass background");
  }
  return Status(env, owner);
}
napi_value Dispose(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  napi_value args[1]; size_t argc = 1; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 1) return Fail(env, "Expected an owner token");
  GlassOwner *owner = GetOwner(env, args[0]); if (!owner) return nullptr;
  Cleanup(owner); return Status(env, owner, "disposed");
}
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"update", nullptr, Update, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 4, methods); return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
