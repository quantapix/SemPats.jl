import Base: GenericIOBuffer

function preproc()
    ccall(:jl_generating_output, Cint, ()) == 1 || return nothing
    precompile(Scan.is_kw, (Kind,))
    precompile(Scan.is_lit, (Kind,))
    precompile(Scan.is_op, (Kind,))
    precompile(Scan.Token, (Kind, Tuple{Int,Int}, Tuple{Int,Int}, Int, Int, String))
    precompile(Scan.Token, ())
    precompile(Scan.kind, (Scan.Token,))
    precompile(Scan.from_loc, (Scan.Token,))
    precompile(Scan.to_loc, (Scan.Token,))
    precompile(Scan.unscan, (Scan.Token,))
    precompile(Scan.unscan, (Scan.RawTok, String))
    precompile(Scan.unscan, (Array{Scan.Token,1},))
    precompile(Scan.unscan, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))

    precompile(Scan.is_cat_id_start, (Char, Int32,))
    precompile(Scan.is_id, (Char,))
    precompile(Scan.is_id_start, (Char,))
    precompile(Scan.peek_one, (GenericIOBuffer{Array{UInt8,1}},))
    precompile(Scan.peek_two, (GenericIOBuffer{Array{UInt8,1}},))
    precompile(Scan.read_one, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.read_one, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok},))
    precompile(Scan.next_token, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))

    precompile(Scan.is_hex, (Char,))
    precompile(Scan.is_biny, (Char,))
    precompile(Scan.is_octal, (Char,))
    precompile(Scan.is_ws, (Char,))
    precompile(Scan.Scanner, (String,))
    precompile(Scan.Scanner, (String, Type{Scan.Token}))
    precompile(Scan.Scanner, (String, Type{Scan.RawTok}))
    precompile(Scan.Scanner, (GenericIOBuffer{Array{UInt8,1}}, Type{Scan.Token}))
    precompile(Scan.Scanner, (GenericIOBuffer{Array{UInt8,1}}, Type{Scan.RawTok}))
    precompile(Scan.scan, (String,))

    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok},))
    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Bool,))
    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, Bool,))
    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Bool,))
    precompile(Scan.iterate, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, Bool,))
    precompile(Scan.from, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.from, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok},))
    precompile(Scan.from!, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Int))
    precompile(Scan.from!, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, Int))
    precompile(Scan.start_token!, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.start_token!, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok},))

    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char,Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char,Char,Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char,Char,Char,Char,Char}, Kind, Char))
    precompile(Scan.try_read, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Tuple{Char,Char,Char,Char,Char,Char,Char,Char}, Kind, Char))

    precompile(Scan.after_greater, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_prime, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_digit, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Kind))
    precompile(Scan.after_identifier, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Char,))
    precompile(Scan.after_less, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_forwardslash, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_minus, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_xor, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_equal, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_bar, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_quote, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_plus, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_dot, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_exclaim, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_colon, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_percent, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_comment, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_comment, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Bool))
    precompile(Scan.after_cmd, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_div, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_circumflex, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_backslash, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_star, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.after_amper, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))

    precompile(Scan.read_string, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Kind,))
    precompile(Scan.read_rest, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Char))

    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, Char,))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, String,))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Base.isdigit),))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Scan.is_ws),))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Scan.is_id),))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Scan.is_hex),))
    precompile(Scan.accept_batch, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Scan.is_ws),))
    precompile(Scan.accept_batch, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token}, typeof(Scan.isdigit),))
    precompile(Scan.emit_rest, (Char, Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.Token},))
    precompile(Scan.emit_rest, (Char, Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok},))

    precompile(Scan.accept_batch, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, typeof(Scan.is_ws),))
    precompile(Scan.accept_batch, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, typeof(Scan.isdigit),))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, Char,))
    precompile(Scan.accept, (Scan.Scanner{GenericIOBuffer{Array{UInt8,1}},Scan.RawTok}, Function,))

    precompile(Scan.read_one, (GenericIOBuffer{Array{UInt8,1}},))    
end
