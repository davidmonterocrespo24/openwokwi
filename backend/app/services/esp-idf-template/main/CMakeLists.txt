# Pure ESP-IDF language mode (issue #139): the user's files are the main
# component sources — they provide app_main() and use IDF APIs directly.
# espidf_compiler sets VELXIO_PURE_SKETCH (and drops ARDUINO_ESP32_PATH from
# the build env) when the frontend requests language='espidf'. As the `main`
# component, ESP-IDF gives these sources an implicit dependency on every
# other component in the build, so driver/, esp_wifi, esp_http_server etc.
# resolve without an explicit REQUIRES.
if(DEFINED ENV{VELXIO_PURE_SKETCH})
    # No CONFIGURE_DEPENDS — see the comment on the Arduino glob below.
    file(GLOB _user_srcs
        "${CMAKE_CURRENT_LIST_DIR}/*.cpp"
        "${CMAKE_CURRENT_LIST_DIR}/*.c")

    idf_component_register(
        SRCS ${_user_srcs}
        INCLUDE_DIRS "."
    )

    # Same -Werror relaxations as the Arduino branch: IDF's defaults are
    # ruthless for user code pasted from tutorials.
    target_compile_options(${COMPONENT_LIB} PRIVATE
        -Wno-error=comment
        -Wno-error=parentheses
        -Wno-error=sign-compare
        -Wno-error=narrowing
        -Wno-error=write-strings
        -Wno-error=missing-field-initializers
        -Wno-error=reorder
        -Wno-error=unused-variable
        -Wno-error=unused-but-set-variable)
# If Arduino component is available, use C++ main and link Arduino.
# The component name matches the directory basename of ARDUINO_ESP32_PATH
# (e.g. "arduino-esp32" when cloned from GitHub).
elseif(DEFINED ENV{ARDUINO_ESP32_PATH})
    get_filename_component(_arduino_comp_name $ENV{ARDUINO_ESP32_PATH} NAME)

    # arduino-esp32 ships esp32-camera as a precompiled static lib but does
    # NOT export its headers from its main CMakeLists. Sketches that
    # #include "esp_camera.h" therefore fail to compile under the IDF
    # build path. We add the bundled headers to the main component's
    # INCLUDE_DIRS unconditionally — harmless for non-camera sketches and
    # the only reliable path for camera sketches under our QEMU pipeline.
    # Normalize Windows backslashes → forward slashes; otherwise CMake
    # parses the resulting paths as escape sequences (\E, \U etc).
    file(TO_CMAKE_PATH "$ENV{ARDUINO_ESP32_PATH}" _arduino_path_norm)
    set(_cam_root "${_arduino_path_norm}/tools/sdk/${IDF_TARGET}/include/esp32-camera")
    set(_cam_includes "")
    if(EXISTS "${_cam_root}/driver/include")
        list(APPEND _cam_includes "${_cam_root}/driver/include")
    endif()
    if(EXISTS "${_cam_root}/conversions/include")
        list(APPEND _cam_includes "${_cam_root}/conversions/include")
    endif()

    # Glob every .cpp / .c that the espidf_compiler dropped into main/
    # alongside main.cpp. Multi-file Arduino projects (robot-desktop-eyes,
    # any wokwi.zip with helper .cpp files, etc.) define classes/free
    # functions in their own translation units; if SRCS only names
    # "main.cpp" the linker dies with "undefined reference to Foo::bar()"
    # for every symbol that lives in a helper .cpp.
    #
    # No CONFIGURE_DEPENDS — ESP-IDF's component_get_requirements.cmake
    # evaluates each component's CMakeLists in script mode where
    # CONFIGURE_DEPENDS isn't supported, and the build aborts with
    # "CONFIGURE_DEPENDS is invalid for script and find package modes".
    # We don't need it anyway: espidf_compiler wipes + restores main/
    # from the template on every compile (touching CMakeLists.txt's
    # mtime), so cmake re-globs naturally on the next configure run.
    file(GLOB _user_srcs
        "${CMAKE_CURRENT_LIST_DIR}/*.cpp"
        "${CMAKE_CURRENT_LIST_DIR}/*.c")

    idf_component_register(
        SRCS ${_user_srcs}
        INCLUDE_DIRS "." ${_cam_includes}
        # `driver` brings in the i2c_master_* + i2c_cmd_link_* symbols
        # libesp32-camera.a's sccb.c references at link time. arduino-esp32
        # doesn't transitively expose it, so we name it here.
        REQUIRES ${_arduino_comp_name} driver
    )

    # Link the precompiled libesp32-camera.a so esp_camera_init / fb_get
    # symbols resolve at link time. The .a ships under the same arduino-esp32
    # tree; if it is missing (older bundle) we silently skip.
    # Use ESP-IDF's add_prebuilt_library so cmake creates a proper imported
    # target with REQUIRES for driver (the .a depends on i2c_master_* +
    # i2c_cmd_link_*) — that way the linker resolves the cross-lib refs.
    # target_link_libraries with INTERFACE doesn't propagate REQUIRES, which
    # is why a bare .a link fails with "undefined reference to i2c_master_…".
    set(_cam_lib "${_arduino_path_norm}/tools/sdk/${IDF_TARGET}/lib/libesp32-camera.a")
    if(EXISTS "${_cam_lib}")
        add_prebuilt_library(esp32_camera_prebuilt "${_cam_lib}"
            REQUIRES driver ${_arduino_comp_name})
        target_link_libraries(${COMPONENT_LIB} PUBLIC esp32_camera_prebuilt)
    endif()

    # arduino-esp32 v2.x's generic `esp32` variant pins_arduino.h does NOT
    # define LED_BUILTIN, so the default Arduino Blink sketch (which Velxio
    # ships in every new project) fails to compile with
    #   error: 'LED_BUILTIN' was not declared in this scope
    # Provide a fallback so sketches "just compile". GPIO 2 is the
    # convention on most ESP32 dev boards (DOIT, NodeMCU, Wemos D1 R32);
    # for ESP32-CAM where GPIO 2 isn't broken out, the user should use an
    # explicit pin number — but this default keeps the new-project flow
    # smooth.
    #
    # SKIP on ESP32-C3 and S3 variants: their pins_arduino.h DOES define
    # LED_BUILTIN already (as `static const uint8_t LED_BUILTIN = ...;`
    # plus `#define LED_BUILTIN LED_BUILTIN`). Pre-defining it from the
    # command line clashes with the self-define: the preprocessor expands
    # `static const uint8_t LED_BUILTIN = ...` to `static const uint8_t 2 = ...`
    # which is a syntax error. Only set the fallback for the generic ESP32
    # Xtensa variant that genuinely lacks the symbol.
    if(NOT IDF_TARGET STREQUAL "esp32c3" AND NOT IDF_TARGET STREQUAL "esp32s3")
        target_compile_definitions(${COMPONENT_LIB} PRIVATE
            "LED_BUILTIN=2")
    endif()

    # Relax `-Werror=` for user sketches. ESP-IDF defaults treat several
    # warning categories as errors (-Werror=comment, -Werror=missing-field-
    # initializers, etc.) which is great for IDF itself but ruthless for
    # user Arduino code that often has nested /* */ comments,
    # parenthesized macros, or other idioms that compile fine under
    # arduino-cli's permissive defaults. Demoting these to plain warnings
    # gives users the same "it just compiles" experience they expect from
    # the Arduino IDE without disabling -Wall entirely.
    target_compile_options(${COMPONENT_LIB} PRIVATE
        -Wno-error=comment
        -Wno-error=parentheses
        -Wno-error=sign-compare
        -Wno-error=narrowing
        -Wno-error=write-strings
        -Wno-error=missing-field-initializers
        -Wno-error=reorder)
else()
    # Pure ESP-IDF mode: main.c #includes sketch_translated.c
    idf_component_register(
        SRCS "main.c"
        INCLUDE_DIRS "."
    )
endif()
