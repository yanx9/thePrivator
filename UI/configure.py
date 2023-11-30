from typing import Optional, Tuple, Union
import customtkinter as ctk
from Model.Profile import Profile

class Config(ctk.CTkToplevel):
    def __init__(self, profile:Profile, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.title(f"Config: {profile.name}")
        self.geometry("400x300")

        self.label = ctk.CTkLabel(self, text="ToplevelWindow")
        self.label.pack(padx=20, pady=20)

# if __name__ == "__main__":
#     profile = Profile(
#         "test", 
#         "116", 
#         "Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.130 Safari/537.36",
#         False,
#         "",
#         "",
#         ""
#         )
#     cfg = Config(profile=profile)
#     cfg.mainloop()