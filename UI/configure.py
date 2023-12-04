from typing import Optional, Tuple, Union
import customtkinter as ctk
from Model.Profile import Profile
from core import Core
from copy import copy

class Config(ctk.CTkToplevel):
    def __init__(self, profile:Profile, update_callback, isNew=False, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.update_callback = update_callback
        self.core = Core()
        self.profile = profile
        self.isNew = isNew
        if self.isNew == True:
            self.title("New Profile")
        else:
            self.title(f"Config: {profile.name}")
        self.geometry("440x400")
        self.grid_columnconfigure(0, weight=1)

        self.mainFrame = ctk.CTkScrollableFrame(self, width=400, height=300)
        self.mainFrame.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="new")
        self.mainFrame.rowconfigure(0, weight=1)
        self.mainFrame.rowconfigure(0, weight=1)

        self.nameFrame = ctk.CTkFrame(self.mainFrame, height=50)
        self.nameFrame.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="new")
        self.nameLabel = ctk.CTkLabel(self.nameFrame, text="Profile name: ")
        self.nameLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="w")
        self.nameEntry = ctk.CTkEntry(self.nameFrame, width=250)
        self.nameEntry.insert(ctk.END, profile.name)
        self.nameEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.nameFrame.columnconfigure(0, weight=1)

        self.uaFrame = ctk.CTkFrame(self.mainFrame, height=50)
        self.uaFrame.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="new")
        self.uaLabel = ctk.CTkLabel(self.uaFrame, text="User agent: ")
        self.uaLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nsw")
        self.uaEntry = ctk.CTkEntry(self.uaFrame, width=250)
        self.uaEntry.insert(ctk.END, self.profile.user_agent)
        self.uaEntry.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="ew")
        self.uaFrame.columnconfigure(0, weight=1)

        self.proxyFrame = ctk.CTkFrame(self.mainFrame, height=50)
        self.proxyFrame.grid(row=2, column=0, padx=10, pady=(10, 10), sticky="new")
        # self.proxySwitchLabel = ctk.CTkLabel(self.proxyFrame, text="Proxy: ")
        # self.proxySwitchLabel.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nw")
        self.proxySwitch = ctk.CTkSwitch(self.proxyFrame, text="Proxy", command=self.toggle_proxy_fields)
        if profile.proxy_flag is 1:
            self.proxySwitch.select()
        self.proxySwitch.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nsw")
        self.proxyUrlLabel = ctk.CTkLabel(self.proxyFrame, text="URL: ")
        self.proxyUrlLabel.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="nsw")
        self.proxyUrlEntry = ctk.CTkEntry(self.proxyFrame, width=250, 
                                          text_color="white" if self.proxySwitch.get() == 1 else "grey")
        self.proxyUrlEntry.insert(ctk.END, self.profile.proxy_url)
        self.proxyUrlEntry.configure(state=ctk.NORMAL if self.proxySwitch.get() == 1 else ctk.DISABLED)
        self.proxyUrlEntry.grid(row=1, column=1, padx=10, pady=(10, 10), sticky="esw")
        self.proxyAuthCheck = ctk.CTkCheckBox(self.proxyFrame, text="Auth?", command=self.toggle_auth_fields)
        if profile.auth_flag is 1:
            self.proxyAuthCheck.select()
        self.proxyAuthCheck.grid(row=2, column=0, padx=10, pady=(10, 10), sticky="wsne")
        self.proxyUserEntry = ctk.CTkEntry(self.proxyFrame, width=250)
        self.proxyPassEntry = ctk.CTkEntry(self.proxyFrame, width=250)
        self.proxyUserEntry.grid(row=3, column=1, padx=10, pady=(10, 10), sticky="wsne")
        self.proxyPassEntry.grid(row=4, column=1, padx=10, pady=(10, 10), sticky="wsne")
        self.proxyUserLabel = ctk.CTkLabel(self.proxyFrame, text="User: ")
        self.proxyUserLabel.grid(row=3, column=0, padx=10, pady=(10, 10), sticky="nsw")
        self.proxyPassLabel = ctk.CTkLabel(self.proxyFrame, text="Pass: ")
        self.proxyPassLabel.grid(row=4, column=0, padx=10, pady=(10, 10), sticky="nsw")
        self.proxyUserEntry.insert(ctk.END, self.profile.proxy_user)
        self.proxyPassEntry.insert(ctk.END, self.profile.proxy_pass)
        self.proxyUserEntry.configure(state=ctk.NORMAL if self.proxyAuthCheck.get() == 1 else ctk.DISABLED, 
                                          text_color="white" if self.proxyAuthCheck.get() == 1 else "grey")
        self.proxyPassEntry.configure(state=ctk.NORMAL if self.proxyAuthCheck.get() == 1 else ctk.DISABLED, 
                                          text_color="white" if self.proxyAuthCheck.get() == 1 else "grey")

        

        self.proxyFrame.columnconfigure(0, weight=1)

        if self.isNew == True:
            saveText = "Add Profile"
        else:
            saveText = "Save Changes"

        self.changesFrame = ctk.CTkFrame(self, height=50)
        """change row to n+1"""
        self.changesFrame.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="sew")
        self.saveButton = ctk.CTkButton(self.changesFrame, text=saveText, command=self.save_changes_callback)
        self.saveButton.grid(row=0, column=0, padx=10, pady=(10, 10), sticky="nwse")
        self.discardButton = ctk.CTkButton(self.changesFrame, text="Discard Changes", command=self.discard_changes_callback)
        self.discardButton.grid(row=0, column=1, padx=10, pady=(10, 10), sticky="nwse")
        self.changesFrame.columnconfigure(0, weight=1)
        self.changesFrame.columnconfigure(1, weight=1)
        print(self.proxyUrlEntry._text_color)

        self.toggle_auth_fields()
        self.toggle_proxy_fields()
        


#  NOTE:  SAVING CHANGES

    def save_changes_callback(self):
        result = copy(self.profile)
        result.name = self.nameEntry.get()
        result.user_agent = self.uaEntry.get()
        result.proxy_flag = self.proxySwitch.get()
        result.proxy_url = self.proxyUrlEntry.get()
        result.proxy_user = self.proxyUserEntry.get()
        result.proxy_pass = self.proxyPassEntry.get()
        result.auth_flag = self.proxyAuthCheck.get()
        print(result.proxy_flag)
        if self.isNew == True:
            res = self.core.new_profile(result)
        else:
            res = self.core.edit_profile(self.profile, result)
        if res == 0:
            self.update_callback()
            self.destroy()

    def discard_changes_callback(self):
        self.destroy()
    
    def toggle_proxy_fields(self):
        print(self.geometry())
        switch_state = self.proxySwitch.get()

        # Enable or disable other fields based on the switch state
        if switch_state == 1:
            self.proxyUrlEntry.configure(state=ctk.NORMAL, text_color="white")
            self.toggle_auth_fields()
        else:
            self.proxyUrlEntry.configure(state=ctk.DISABLED, text_color="grey")
            self.proxyAuthCheck.configure(state=ctk.DISABLED) 
            self.proxyUserEntry.configure(state=ctk.DISABLED, text_color="grey")
            self.proxyPassEntry.configure(state=ctk.DISABLED, text_color="grey")

    def toggle_auth_fields(self):
        if self.proxySwitch.get() == 0:
            pass
        switch_state = self.proxyAuthCheck.get()
        print(self.proxyAuthCheck.get())

        # Enable or disable other fields based on the switch state
        if switch_state == 1:
            self.proxyUserEntry.configure(state=ctk.NORMAL, text_color="white")
            self.proxyPassEntry.configure(state=ctk.NORMAL, text_color="white") 
        else:
            self.proxyUserEntry.configure(state=ctk.DISABLED, text_color="grey")
            self.proxyPassEntry.configure(state=ctk.DISABLED, text_color="grey") 
            