from typing import Optional, Tuple, Union
import customtkinter as ctk
from core import Core
from Model.Profile import Profile
from UI.configure import Config
from UI.settings import Settings
import utils

class App(ctk.CTk):
    
    def __init__(self, *args, **kwargs):
        self.core = Core()
        # print(core.loaded_profiles)
        super().__init__(*args, **kwargs)
        self.geometry(f"{1100}x{700}")
        self.title("thePrivator")
        self.grid_columnconfigure(0, weight=1)
     #   self.grid_rowconfigure(10, weight=1)

        self.top_frame = ctk.CTkFrame(self, height=40)
        self.top_frame.grid(row=0, column=0, padx=10, pady=(10, 0), sticky="new")
        self.searchBar = ctk.CTkEntry(self.top_frame, height=30, placeholder_text="Search", border_width=0)
        self.searchBar.grid(row=0, column=0, padx=10, pady=(10, 10))
        self.createButton = ctk.CTkButton(self.top_frame, width=30, height=30, text="New Profile", command=self.add_profile_callback)
        self.createButton.grid(row=0, column=1, padx=10, pady=(10, 10))
        self.settingsButton = ctk.CTkButton(self.top_frame, width=30, height=30, text="Settings", command=self.settings_callback)
        self.settingsButton.grid(row=0, column=2, padx=10, pady=(10, 10))
        self.profile_frames = {}
        self.start_buttons = {}
        self.edit_buttons = {}
        self.delete_buttons = {}
        self.config_windows = {}
        self.update_list()
            

    def update_list(self):
        for widget in self.grid_slaves():
                if widget.grid_info()['row'] > 0:
                    widget.destroy()
        self.core.load_profiles()
        if self.core.loaded_profiles == []:
            label = ctk.CTkLabel(self, text="No profiles! Add a profile to start...")
            label.grid(row=1, column=0, padx=10, pady=(10, 10), sticky="nswe")
            pass
        self.core.check_running_processes()
        for i, profile, in enumerate(self.core.loaded_profiles):
            self.profile_frames.update({profile.name: ctk.CTkFrame(self, height=50)})
            self.profile_frames[profile.name].grid(row=i+1, column=0, padx=10, pady=(10, 0), sticky="new")
            
            label = ctk.CTkLabel(self.profile_frames[profile.name], text=profile.name)
            label.grid(row=0, column=0, padx=10, pady=(10, 10))
            if profile.name not in self.core.active_processes:
                startButton = ctk.CTkButton(self.profile_frames[profile.name],
                                              fg_color='green', width=30, height=30, text="▶️",
                                                command=lambda arg=profile: self.run_profile_callback(arg))
            else:
                startButton = ctk.CTkButton(self.profile_frames[profile.name],
                                            fg_color='red', width=30, height=30, text="⏹️",
                                                    command=lambda arg=profile: self.stop_profile_callback(arg))
            editButton = ctk.CTkButton(self.profile_frames[profile.name],
                                              fg_color='blue', width=30, height=30, text="✏️",
                                                command=lambda arg=profile: self.edit_profile_callback(arg))
            # editButton = ctk.CTkButton(self.profile_frames[profile.name],
            #                                   fg_color='blue', width=30, height=30, text="✏️",
            #                                     command=print(f"EDIT: {profile.name}"))
            deleteButton = ctk.CTkButton(self.profile_frames[profile.name],
                                              fg_color='red', width=30, height=30, text="🗑️",
                                                command=lambda arg=profile: self.delete_profile_callback(arg))
            sizeLabel = ctk.CTkLabel(self.profile_frames[profile.name],
                                     text = utils.get_folder_size(utils.get_profile_path(profile)))
        
            startButton.grid(row=0, column=1, padx=10, pady=(10, 10))
            editButton.grid(row=0, column=2, padx=10, pady=(10, 10))
            deleteButton.grid(row=0, column=3, padx=10, pady=(10, 10))
            sizeLabel.grid(row=0, column=4, padx=10, pady=(10, 10))

            self.start_buttons.update({profile.name: startButton})
            self.edit_buttons.update({profile.name: editButton})
            self.delete_buttons.update({profile.name: deleteButton})
        print(self.core.active_processes)


    def run_profile_callback(self, profile:Profile):
        self.core.run_profile(profile)
        self.start_buttons[profile.name].configure(fg_color='red', text="⏹️",
                                                    command=lambda arg=profile: self.stop_profile_callback(arg))
    
    def stop_profile_callback(self, profile:Profile):
        self.core.stop_profile(profile)
        self.start_buttons[profile.name].configure(fg_color='green', text="▶️",
                                                    command=lambda arg=profile: self.run_profile_callback(arg))

    def edit_profile_callback(self, profile:Profile):
        self.config_windows.update({profile.name: None})
        if self.config_windows[profile.name] is None or not self.config_windows[profile.name].winfo_exists():
            self.config_windows.update({profile.name: Config(profile=profile, update_callback=self.update_list)}) # create window if its None or destroyed
            self.config_windows[profile.name].focus()
        else:
            self.config_windows[profile.name].focus()  # if window exists focus it
        #self.wait_window(self.config_windows[profile.name])

        #self.config_windows[profile.name].protocol("WM_DELETE_WINDOW", self.update_list())

    def settings_callback(self):
        Settings()

    def delete_profile_callback(self, profile:Profile):
        self.core.delete_profile(profile=profile)
        self.profile_frames.pop(profile.name)
        self.start_buttons.pop(profile.name)
        self.edit_buttons.pop(profile.name)
        self.delete_buttons.pop(profile.name)
        self.update_list()

    def add_profile_callback(self):
        self.newConfigure = Config(profile=Profile(), update_callback=self.update_list, isNew=True)


if __name__ == "__main__":
    app = App()
    app.mainloop()