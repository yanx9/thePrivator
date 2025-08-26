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
        else:
            # Use default User-Agent initially
            default_ua = self.config_manager.get('default_user_agent')
            self.ua_text.insert("1.0", default_ua)

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

            if self.profile:
                # Edit existing profile
                self.profile_manager.update_profile(
                    self.profile.id,
                    name=name,
                    user_agent=user_agent,
                    proxy=proxy,
                    notes=notes
                )
                self.result = self.profile
            else:
                # Create new profile
                self.result = self.profile_manager.create_profile(
                    name=name,
                    user_agent=user_agent,
                    proxy=proxy,
                    notes=notes
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
