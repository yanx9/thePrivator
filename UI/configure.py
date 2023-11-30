from typing import Optional, Tuple, Union
import customtkinter as ctk
from Model.Profile import Profile
from core import Core

class Config(ctk.CTkToplevel):
    def __init__(self, profile:Profile, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.core = Core()
        self.profile=profile
        self.title(f"Config: {profile.name}")
        self.geometry("400x300")
        self.grid_columnconfigure(0, weight=1)

        self.nameFrame = ctk.CTkFrame(self, height=50)
        self.nameFrame.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="new")
        self.nameLabel = ctk.CTkLabel(self.nameFrame, text="Profile name: ")
        self.nameLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.nameEntry = ctk.CTkEntry(self.nameFrame, width=250)
        self.nameEntry.insert(ctk.END, profile.name)
        self.nameEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.nameFrame.columnconfigure(0, weight=1)

        self.uaFrame = ctk.CTkFrame(self, height=50)
        self.uaFrame.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="new")
        self.uaLabel = ctk.CTkLabel(self.uaFrame, text="User agent: ")
        self.uaLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.uaEntry = ctk.CTkEntry(self.uaFrame, width=250)
        self.uaEntry.insert(ctk.END, profile.user_agent)
        self.uaEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.uaFrame.columnconfigure(0, weight=1)


        self.changesFrame = ctk.CTkFrame(self, height=50)
        """change row to n+1"""
        self.changesFrame.grid(row=2, column=0, padx=10, pady=(10, 10), sticky="sew")
        self.saveButton = ctk.CTkButton(self.changesFrame, text="Save Changes", command=self.save_changes_callback)
        self.saveButton.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="e")
        self.discardButton = ctk.CTkButton(self.changesFrame, text="Discard Changes", command=self.discard_changes_callback)
        self.discardButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="e")
    
    def save_changes_callback(self):
        test = self.profile
        test.name = self.nameEntry.get()
        test.user_agent = self.uaEntry.get()
        self.core.edit_profile(self.profile, test)
        self.destroy()

    def discard_changes_callback(self):
        self.destroy()

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