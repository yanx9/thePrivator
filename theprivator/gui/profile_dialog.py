"""Profile creation and editing dialog that sources User-Agents via utils."""

import customtkinter as ctk
from typing import Optional
import tkinter.messagebox as msgbox
import sys
from pathlib import Path

# Add src to path
src_dir = Path(__file__).parent.parent.absolute()
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from core.profile_manager import ProfileManager, ChromiumProfile
from core.config_manager import ConfigManager
from core.fingerprint_presets import FINGERPRINT_PRESETS, get_preset_names
from core.fingerprint_generator import FingerprintGenerator
from utils.logger import get_logger
from utils.exceptions import ValidationError, ProfileError

# ⬇️ our new utilities
from utils.user_agents import get_user_agents_async


class ProfileDialog(ctk.CTkToplevel):
    """Dialog for creating/editing profiles."""

    def __init__(self, parent, profile_manager: ProfileManager,
                 config_manager: ConfigManager, profile: Optional[ChromiumProfile] = None):
        super().__init__(parent)

        self.profile_manager = profile_manager
        self.config_manager = config_manager
        self.profile = profile
        self.result = None
        self.logger = get_logger(__name__)
        self.fp_generator = FingerprintGenerator()

        # state
        self.user_agents = []  # filled asynchronously

        self._setup_dialog()
        self._create_widgets()
        self._populate_fields()

        # Kick off UA list download via utils (async)
        self.ua_status_label.configure(text="Loading online user-agents…")
        get_user_agents_async(lambda uas: self.after(0, lambda: self._on_uas_loaded(uas)))

        # Modal
        self.transient(parent)
        self.grab_set()
        self.focus()

    def _bind_mousewheel_recursive(self, widget, canvas_widget):
        """Recursively binds mouse wheel to widget and all its children."""
        def _on_mousewheel(event):
            # Calculate scroll amount
            if event.delta:
                # Windows
                delta = -1 * (event.delta / 120)
            else:
                # Linux
                if event.num == 4:
                    delta = -1
                elif event.num == 5:
                    delta = 1
                else:
                    delta = 0
            
            # Scroll the target canvas
            try:
                if hasattr(canvas_widget, '_parent_canvas'):
                    canvas_widget._parent_canvas.yview_scroll(int(delta), "units")
                elif hasattr(canvas_widget, 'canvas'):
                    canvas_widget.canvas.yview_scroll(int(delta), "units")
            except Exception as e:
                self.logger.debug(f"Scroll error: {e}")
        
        # Bind to current widget
        widget.bind("<MouseWheel>", _on_mousewheel, "+")
        widget.bind("<Button-4>", _on_mousewheel, "+")
        widget.bind("<Button-5>", _on_mousewheel, "+")
        
        # Recursively bind to all children
        try:
            for child in widget.winfo_children():
                self._bind_mousewheel_recursive(child, canvas_widget)
        except:
            pass

    def _setup_scrolling_for_frame(self, scrollable_frame):
        """Sets up comprehensive scrolling for a scrollable frame."""
        # Initial binding to the scrollable frame itself
        self._bind_mousewheel_recursive(scrollable_frame, scrollable_frame)
        
        # Also bind to the internal canvas directly
        def delayed_bind():
            try:
                canvas = None
                if hasattr(scrollable_frame, '_parent_canvas'):
                    canvas = scrollable_frame._parent_canvas
                elif hasattr(scrollable_frame, 'canvas'):
                    canvas = scrollable_frame.canvas
                    
                if canvas:
                    def canvas_scroll(event):
                        if event.delta:
                            delta = -1 * (event.delta / 120)
                        else:
                            delta = -1 if event.num == 4 else 1 if event.num == 5 else 0
                        canvas.yview_scroll(int(delta), "units")
                    
                    canvas.bind("<MouseWheel>", canvas_scroll, "+")
                    canvas.bind("<Button-4>", canvas_scroll, "+")
                    canvas.bind("<Button-5>", canvas_scroll, "+")
            except Exception as e:
                self.logger.debug(f"Canvas binding error: {e}")
        
        # Delay to ensure canvas is created
        scrollable_frame.after(100, delayed_bind)

    def _setup_dialog(self) -> None:
        """Configures dialog."""
        title = "Edit Profile" if self.profile else "New Profile"
        self.title(title)
        self.geometry("550x650")
        self.resizable(False, False)

        # Center on parent
        self.update_idletasks()
        x = (self.winfo_screenwidth() // 2) - (550 // 2)
        y = (self.winfo_screenheight() // 2) - (650 // 2)
        self.geometry(f"550x650+{x}+{y}")

    def _create_widgets(self) -> None:
        """Creates dialog widgets."""
        # Main frame
        main_frame = ctk.CTkFrame(self)
        main_frame.pack(fill="both", expand=True, padx=20, pady=20)

        # Title
        title_text = "Edit profile" if self.profile else "Create new profile"
        title_label = ctk.CTkLabel(
            main_frame,
            text=title_text,
            font=ctk.CTkFont(size=18, weight="bold")
        )
        title_label.pack(pady=(10, 20))

        # Scrollable frame for form
        scroll_frame = ctk.CTkScrollableFrame(main_frame, height=400)
        scroll_frame.pack(fill="both", expand=True, padx=10, pady=10)

        # Profile name
        name_frame = ctk.CTkFrame(scroll_frame)
        name_frame.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(
            name_frame,
            text="📋 Profile name:",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=10, pady=(10, 5))

        self.name_entry = ctk.CTkEntry(
            name_frame,
            placeholder_text="Enter profile name...",
            height=35
        )
        self.name_entry.pack(fill="x", padx=10, pady=(0, 10))

        # User-Agent
        ua_frame = ctk.CTkFrame(scroll_frame)
        ua_frame.pack(fill="x", padx=10, pady=10)

        ua_header = ctk.CTkFrame(ua_frame)
        ua_header.pack(fill="x", padx=10, pady=(10, 5))

        ctk.CTkLabel(
            ua_header,
            text="🌐 User-Agent:",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(side="left")

        # 🎲 Random UA button (enabled after list loads)
        self.ua_random_btn = ctk.CTkButton(
            ua_header,
            text="🎲 Random User-Agent",
            command=self._pick_random_user_agent,
            width=200,
            state="disabled"
        )
        self.ua_random_btn.pack(side="right")

        self.ua_text = ctk.CTkTextbox(
            ua_frame,
            height=80,
            wrap="word"
        )
        self.ua_text.pack(fill="x", padx=10, pady=(5, 4))

        # Status line under UA box (shows loading/loaded/error)
        self.ua_status_label = ctk.CTkLabel(
            ua_frame,
            text="",
            font=ctk.CTkFont(size=11),
            text_color="gray"
        )
        self.ua_status_label.pack(anchor="w", padx=12, pady=(0, 10))

        # Proxy
        proxy_frame = ctk.CTkFrame(scroll_frame)
        proxy_frame.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(
            proxy_frame,
            text="🔗 Proxy (optional):",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=10, pady=(10, 5))

        self.proxy_entry = ctk.CTkEntry(
            proxy_frame,
            placeholder_text="http://host:port or socks5://host:port",
            height=35
        )
        self.proxy_entry.pack(fill="x", padx=10, pady=(0, 5))

        proxy_help = ctk.CTkLabel(
            proxy_frame,
            text="Examples: http://proxy.com:8080, socks5://127.0.0.1:1080",
            font=ctk.CTkFont(size=11),
            text_color="gray"
        )
        proxy_help.pack(anchor="w", padx=10, pady=(0, 10))

        # Fingerprint Configuration
        fp_frame = ctk.CTkFrame(scroll_frame)
        fp_frame.pack(fill="x", padx=10, pady=10)

        fp_header = ctk.CTkFrame(fp_frame)
        fp_header.pack(fill="x", padx=10, pady=(10, 5))

        ctk.CTkLabel(
            fp_header,
            text="🔒 Fingerprint Protection:",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(side="left")

        # Mode selector
        self.fp_mode_var = ctk.StringVar(value="Disabled")
        fp_mode_menu = ctk.CTkOptionMenu(
            fp_header,
            values=["Disabled", "Simple (Presets)"],
            variable=self.fp_mode_var,
            command=self._on_fp_mode_change,
            width=180
        )
        fp_mode_menu.pack(side="right")

        # Simple mode frame (preset dropdown)
        self.simple_fp_frame = ctk.CTkFrame(fp_frame)

        ctk.CTkLabel(
            self.simple_fp_frame,
            text="Preset Profile:",
            font=ctk.CTkFont(size=12)
        ).pack(side="left", padx=(10, 5))

        self.preset_var = ctk.StringVar(value=get_preset_names()[0])
        preset_menu = ctk.CTkOptionMenu(
            self.simple_fp_frame,
            values=get_preset_names(),
            variable=self.preset_var,
            command=self._on_preset_change,
            width=300
        )
        preset_menu.pack(side="left", padx=5)

        # Help text
        fp_help = ctk.CTkLabel(
            fp_frame,
            text="Enable fingerprint protection to mask Canvas, WebGL, Audio, and other browser fingerprints",
            font=ctk.CTkFont(size=11),
            text_color="gray",
            wraplength=500
        )
        fp_help.pack(anchor="w", padx=10, pady=(5, 10))

        # Notes
        notes_frame = ctk.CTkFrame(scroll_frame)
        notes_frame.pack(fill="x", padx=10, pady=10)

        ctk.CTkLabel(
            notes_frame,
            text="📝 Notes (optional):",
            font=ctk.CTkFont(size=14, weight="bold")
        ).pack(anchor="w", padx=10, pady=(10, 5))

        self.notes_text = ctk.CTkTextbox(
            notes_frame,
            height=80,
            wrap="word"
        )
        self.notes_text.pack(fill="x", padx=10, pady=(5, 10))

        # Buttons
        buttons_frame = ctk.CTkFrame(main_frame)
        buttons_frame.pack(fill="x", padx=10, pady=20)

        cancel_btn = ctk.CTkButton(
            buttons_frame,
            text="❌ Cancel",
            command=self._on_cancel,
            fg_color="gray",
            hover_color="darkgray",
            width=120
        )
        cancel_btn.pack(side="left", padx=10)

        save_text = "💾 Save" if self.profile else "➕ Create"
        save_btn = ctk.CTkButton(
            buttons_frame,
            text=save_text,
            command=self._on_save,
            fg_color="darkgreen",
            hover_color="green",
            width=120
        )
        save_btn.pack(side="right", padx=10)
        self._setup_scrolling_for_frame(scroll_frame)

    def _populate_fields(self) -> None:
        """Populates form fields."""
        if self.profile:
            # Fill fields with existing profile data
            self.name_entry.insert(0, self.profile.name)
            self.ua_text.insert("1.0", self.profile.user_agent)

            if self.profile.proxy:
                self.proxy_entry.insert(0, self.profile.proxy)

            if hasattr(self.profile, 'notes') and self.profile.notes:
                self.notes_text.insert("1.0", self.profile.notes)

            # Populate fingerprint settings
            if self.profile.fingerprint and self.profile.fingerprint.mode != "disabled":
                if self.profile.fingerprint.mode == "simple":
                    self.fp_mode_var.set("Simple (Presets)")
                    if self.profile.fingerprint.preset_name:
                        self.preset_var.set(self.profile.fingerprint.preset_name)
                    self._on_fp_mode_change("Simple (Presets)")
                else:
                    self.fp_mode_var.set("Disabled")
            else:
                self.fp_mode_var.set("Disabled")

        else:
            # Use default User-Agent initially
            default_ua = self.config_manager.get('default_user_agent')
            self.ua_text.insert("1.0", default_ua)
            self.fp_mode_var.set("Disabled")

    # --- User-Agent callbacks (GUI <-> utils) ---

    def _on_uas_loaded(self, uas):
        """Called (on UI thread) when utils finishes loading UAs."""
        self.user_agents = uas or []
        if self.user_agents:
            self.ua_random_btn.configure(state="normal")
            self.ua_status_label.configure(text=f"Loaded {len(self.user_agents):,} user-agents")
        else:
            self.ua_random_btn.configure(state="disabled")
            self.ua_status_label.configure(text="Could not load online user-agents")

    def _pick_random_user_agent(self) -> None:
        """Puts a random UA (from the already loaded list) into the textbox."""
        if not self.user_agents:
            msgbox.showwarning("User-Agent", "User-agent list not loaded yet.")
            return
        import random
        choice = random.choice(self.user_agents)
        self.ua_text.delete("1.0", "end")
        self.ua_text.insert("1.0", choice)

    # --- Fingerprint callbacks ---

    def _on_fp_mode_change(self, mode: str) -> None:
        """Handle fingerprint mode change."""
        if mode == "Disabled":
            self.simple_fp_frame.pack_forget()
            # Re-enable user agent field
            self.ua_text.configure(state="normal")
            self.ua_random_btn.configure(state="normal" if hasattr(self, '_user_agents') and self._user_agents else "disabled")
        elif mode == "Simple (Presets)":
            self.simple_fp_frame.pack(fill="x", padx=10, pady=(5, 0))
            # Auto-fill user agent from preset
            self._on_preset_change(self.preset_var.get())

    def _on_preset_change(self, preset_name: str) -> None:
        """Handle preset selection change - auto-fill user agent."""
        from core.fingerprint_presets import FINGERPRINT_PRESETS

        preset = FINGERPRINT_PRESETS.get(preset_name)
        if preset and preset.get("user_agent"):
            # Auto-fill user agent
            self.ua_text.delete("1.0", "end")
            self.ua_text.insert("1.0", preset["user_agent"])
            # Make it read-only (but still visible)
            self.ua_text.configure(state="disabled")
            self.ua_random_btn.configure(state="disabled")

    # --- Validation / actions ---

    def _test_configuration(self) -> None:
        """Tests profile configuration."""
        try:
            # Get data from form
            name = self.name_entry.get().strip()
            user_agent = self.ua_text.get("1.0", "end").strip()
            proxy = self.proxy_entry.get().strip()

            # Validation
            from utils.validator import validate_profile_name, validate_user_agent, validate_proxy

            if not validate_profile_name(name):
                raise ValidationError("Invalid profile name")

            if not validate_user_agent(user_agent):
                raise ValidationError("Invalid User-Agent")

            if proxy and not validate_proxy(proxy):
                raise ValidationError("Invalid proxy format")

            msgbox.showinfo(
                "Configuration Test",
                "✅ Profile configuration is valid!"
            )

        except ValidationError as e:
            msgbox.showerror("Validation Error", str(e))
        except Exception as e:
            msgbox.showerror("Error", f"Unexpected error: {e}")

    def _on_save(self) -> None:
        """Saves profile."""
        try:
            # Get data from form
            name = self.name_entry.get().strip()
            user_agent = self.ua_text.get("1.0", "end").strip()
            proxy = self.proxy_entry.get().strip() or None
            notes = self.notes_text.get("1.0", "end").strip()

            # Generate fingerprint config based on mode
            fp_mode = self.fp_mode_var.get()
            if fp_mode == "Disabled":
                from core.profile_manager import FingerprintConfig
                fingerprint = FingerprintConfig(mode="disabled")
            elif fp_mode == "Simple (Presets)":
                preset_name = self.preset_var.get()
                fingerprint = self.fp_generator.generate_from_preset(preset_name)
                fingerprint.mode = "simple"
                fingerprint.preset_name = preset_name

                # CRITICAL: Override user agent from preset
                from core.fingerprint_presets import FINGERPRINT_PRESETS
                preset = FINGERPRINT_PRESETS.get(preset_name)
                if preset and preset.get("user_agent"):
                    user_agent = preset["user_agent"]
                    self.logger.info(f"Using preset User-Agent: {user_agent[:50]}...")
            else:
                from core.profile_manager import FingerprintConfig
                fingerprint = FingerprintConfig(mode="disabled")

            if self.profile:
                # Edit existing profile
                self.profile_manager.update_profile(
                    self.profile.id,
                    name=name,
                    user_agent=user_agent,
                    proxy=proxy,
                    notes=notes,
                    fingerprint=fingerprint
                )
                # Get the updated profile from the manager
                self.result = self.profile_manager.get_profile(self.profile.id)
            else:
                # Create new profile
                self.result = self.profile_manager.create_profile(
                    name=name,
                    user_agent=user_agent,
                    proxy=proxy,
                    notes=notes
                )
                # Set fingerprint and update
                self.result.fingerprint = fingerprint
                self.profile_manager.update_profile(
                    self.result.id,
                    fingerprint=fingerprint
                )

            self.destroy()

        except ValidationError as e:
            msgbox.showerror("Validation Error", str(e))
        except ProfileError as e:
            msgbox.showerror("Profile Error", str(e))
        except Exception as e:
            msgbox.showerror("Error", f"Unexpected error: {e}")
            self.logger.error(f"Error saving profile: {e}")

    def _on_cancel(self) -> None:
        """Cancels dialog."""
        self.result = None
        self.destroy()
