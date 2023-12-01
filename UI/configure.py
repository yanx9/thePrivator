from typing import Optional, Tuple, Union
import customtkinter as ctk
from Model.Profile import Profile
from core import Core

class Config(ctk.CTkToplevel):
    def __init__(self, profile:Profile, update_callback, isNew=False, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.update_callback = update_callback
        self.core = Core()
        self.profile = profile
        self.isNew = isNew
        if self.isNew == True:
            self.title(f"New Profile")
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
        self.uaLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nw")
        self.uaEntry = ctk.CTkEntry(self.uaFrame, width=250)
        self.uaEntry.insert(ctk.END, profile.user_agent)
        self.uaEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.uaFrame.columnconfigure(0, weight=1)

        self.proxyFrame = ctk.CTkFrame(self, height=50)
        self.proxyFrame.grid(row=2, column=0, padx=10, pady=(10, 10), sticky="new")
        # self.proxySwitchLabel = ctk.CTkLabel(self.proxyFrame, text="Proxy: ")
        # self.proxySwitchLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nw")
        self.proxySwitch = ctk.CTkSwitch(self.proxyFrame, text="Proxy", command=self.toggle_proxy_fields)
        if profile.proxy_flag is 1:
            self.proxySwitch.select()
        self.proxySwitch.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nw")
        self.proxyUrlLabel = ctk.CTkLabel(self.proxyFrame, text="URL: ")
        self.proxyUrlLabel.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="nw")
        self.proxyUrlEntry = ctk.CTkEntry(self.proxyFrame, width=250, state=ctk.NORMAL if self.proxySwitch.get() == 1 else ctk.DISABLED)
        self.proxyUrlEntry.insert(ctk.END, profile.proxy_url)
        self.proxyUrlEntry.grid(row=1, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.proxyFrame.columnconfigure(0, weight=1)

        if self.isNew == True:
            saveText = "Add Profile"
        else:
            saveText = "Save Changes"

        self.changesFrame = ctk.CTkFrame(self, height=50)
        """change row to n+1"""
        self.changesFrame.grid(row=3, column=0, padx=10, pady=(10, 10), sticky="sew")
        self.saveButton = ctk.CTkButton(self.changesFrame, text=saveText, command=self.save_changes_callback)
        self.saveButton.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nwse")
        self.discardButton = ctk.CTkButton(self.changesFrame, text="Discard Changes", command=self.discard_changes_callback)
        self.discardButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="nwse")
        self.changesFrame.columnconfigure(0, weight=1)
        self.changesFrame.columnconfigure(1, weight=1)


#  NOTE:  SAVING CHANGES

    def save_changes_callback(self):
        result = self.profile
        result.name = self.nameEntry.get()
        result.user_agent = self.uaEntry.get()
        result.proxy_flag = self.proxySwitch.get()
        result.proxy_url = self.proxyUrlEntry.get()
        print(result.proxy_flag)
        if self.isNew == True:
            self.core.new_profile(result)
        else:
            self.core.edit_profile(self.profile, result)
        self.update_callback()
        self.destroy()

    def discard_changes_callback(self):
        self.destroy()
    
    def toggle_proxy_fields(self):
        switch_state = self.proxySwitch.get()

        # Enable or disable other fields based on the switch state
        self.proxyUrlEntry.configure(state=ctk.NORMAL if switch_state == 1 else ctk.DISABLED)
        # entry2.config(state=tk.NORMAL if switch_state == 1 else tk.DISABLED)
        # button.config(state=tk.NORMAL if switch_state == 1 else tk.DISABLED)

# Create the main window
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